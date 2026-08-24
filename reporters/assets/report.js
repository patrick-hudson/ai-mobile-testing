(() => {
  'use strict';

  const manifest = JSON.parse(document.getElementById('audit-manifest').textContent);
  const list = document.getElementById('audit-list');
  const controls = {
    search: document.getElementById('search'),
    status: document.getElementById('status-filter'),
    area: document.getElementById('area-filter'),
    severity: document.getElementById('severity-filter'),
    environment: document.getElementById('environment-filter'),
    blocking: document.getElementById('blocking-only'),
    baseline: document.getElementById('baseline-only'),
  };

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
  const text = (value) => escapeHtml(value == null || value === '' ? '—' : value);
  const formatDuration = (milliseconds) => {
    if (milliseconds == null) return '—';
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
    return `${(milliseconds / 60_000).toFixed(1)} min`;
  };
  const formatBytes = (bytes) => {
    if (bytes == null) return 'unknown size';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  };
  const badge = (label, css = '') => `<span class="badge ${css}">${text(label)}</span>`;
  const jsonBlock = (value) => `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;

  function artifactHtml(artifact) {
    const unavailable = !artifact.available || !artifact.href;
    const link = unavailable
      ? `<span>${text(artifact.name)} (unavailable)</span>`
      : `<a href="${escapeHtml(artifact.href)}" target="_blank" rel="noopener">${text(artifact.name)}</a>`;
    let preview = '';
    const posterLink = artifact.poster?.href
      ? `<div class="poster-meta"><a href="${escapeHtml(artifact.poster.href)}" target="_blank" rel="noopener">Open video poster</a> · ${text(formatBytes(artifact.poster.sizeBytes))} · SHA-256 ${text(artifact.poster.sha256)}</div>`
      : '';
    if (!unavailable && artifact.kind === 'video') {
      const poster = artifact.poster?.href ? ` poster="${escapeHtml(artifact.poster.href)}"` : '';
      preview = `<video controls preload="metadata"${poster}><source src="${escapeHtml(artifact.href)}" type="${escapeHtml(artifact.contentType)}">Download the linked video to view it.</video>`;
    } else if (!unavailable && artifact.kind === 'screenshot') {
      preview = `<a href="${escapeHtml(artifact.href)}" target="_blank" rel="noopener"><img loading="lazy" src="${escapeHtml(artifact.href)}" alt="${escapeHtml(artifact.name)}"></a>`;
    }
    return `<article class="media">
      <div>${badge(artifact.kind)} ${link}</div>
      <div class="artifact-meta">${text(formatBytes(artifact.sizeBytes))}${artifact.sha256 ? ` · SHA-256 ${text(artifact.sha256)}` : ''}</div>
      ${posterLink}
      ${artifact.error ? `<p class="finding blocking">${text(artifact.error)}</p>` : ''}
      ${artifact.posterError ? `<p class="finding">Poster unavailable: ${text(artifact.posterError)}</p>` : ''}
      ${preview}
    </article>`;
  }

  function evidenceContext(execution) {
    const evidence = execution.evidence;
    if (!evidence) {
      return '<p class="empty">No structured <code>audit-result</code> JSON was attached. This execution cannot be treated as a validated pass.</p>';
    }
    const steps = evidence.steps.length
      ? `<ol>${evidence.steps.map((step) => `<li><strong>${text(step.name)}</strong> ${badge(step.status)}<br>Expected: ${text(step.expected)}${step.detail ? `<br>${text(step.detail)}` : ''}</li>`).join('')}</ol>`
      : '<p class="empty">No step records.</p>';
    const findings = evidence.findings.length
      ? `<ul>${evidence.findings.map((finding) => `<li class="finding ${finding.blocking ? 'blocking' : ''}"><strong>${text(finding.severity)} · ${text(finding.title)}</strong><br>${text(finding.detail)}</li>`).join('')}</ul>`
      : '<p class="empty">No findings recorded.</p>';
    const observations = evidence.observations.length
      ? `<ul>${evidence.observations.map((observation) => `<li><strong>${text(observation.label)}:</strong> ${text(observation.value)}${observation.expected ? `<br><small>Expected: ${text(observation.expected)}</small>` : ''}</li>`).join('')}</ul>`
      : '<p class="empty">No observations recorded.</p>';
    const diagnostics = {
      pageInspections: evidence.pageInspections,
      consoleErrors: evidence.consoleErrors,
      consoleWarnings: evidence.consoleWarnings,
      pageErrors: evidence.pageErrors,
      expectedThirdPartyTelemetry: evidence.thirdPartyTelemetryDiagnostics,
      failedRequests: evidence.failedRequests,
      badResponses: evidence.badResponses,
    };
    const environment = {
      environment: evidence.environment,
      baseURL: evidence.baseURL,
      project: evidence.project,
      browser: evidence.browser,
      viewport: evidence.viewport,
      timezone: evidence.timezone,
      startedAt: evidence.startedAt,
      finishedAt: evidence.finishedAt,
    };
    return `<div class="context-grid">
      <section class="context-panel"><h4>Execution environment</h4>${jsonBlock(environment)}</section>
      <section class="context-panel"><h4>Numbered actions and expectations</h4>${steps}</section>
      <section class="context-panel"><h4>Findings</h4>${findings}</section>
      <section class="context-panel"><h4>Observed values</h4>${observations}</section>
      <section class="context-panel"><h4>Page and runtime diagnostics</h4>${jsonBlock(diagnostics)}</section>
    </div>`;
  }

  function executionHtml(execution) {
    const errors = execution.errors.length ? `<section class="context-panel"><h4>Test errors</h4>${jsonBlock(execution.errors)}</section>` : '';
    const processOutput = execution.stdout.length || execution.stderr.length
      ? `<section class="context-panel"><h4>Process output</h4>${jsonBlock({ stdout: execution.stdout, stderr: execution.stderr })}</section>`
      : '';
    const attemptHistory = execution.attemptHistory?.length > 1
      ? `<section class="context-panel"><h4>Attempt history</h4>${jsonBlock(execution.attemptHistory.map((attempt) => ({
          attempt: attempt.attempt,
          retry: attempt.retry,
          status: attempt.status,
          durationMs: attempt.durationMs,
          startedAt: attempt.startedAt,
          structuredEvidence: attempt.structuredEvidence,
          errors: attempt.errors,
          artifacts: attempt.artifacts.map((artifact) => ({
            name: artifact.name,
            kind: artifact.kind,
            href: artifact.href,
            poster: artifact.poster?.href ?? null,
          })),
        })))}</section>`
      : '';
    const annotations = execution.annotations.length
      ? `<section class="context-panel"><h4>Review annotations</h4>${jsonBlock(execution.annotations)}</section>`
      : '';
    const media = execution.artifacts.length
      ? `<div class="media-grid">${execution.artifacts.map(artifactHtml).join('')}</div>`
      : '<p class="empty">No media or data attachments were produced.</p>';
    return `<article class="execution">
      <h3>${text(execution.project)} ${badge(execution.status, `status-${execution.status}`)}</h3>
      <div class="execution-meta">
        <span>${text(execution.environment)}</span><span>${text(execution.browser)}</span><span>${text(execution.deviceClass)}</span><span>TLS: ${text(execution.tlsPolicy)}</span>
        <span>${text(formatDuration(execution.durationMs))}</span><span>${execution.attempts} attempt${execution.attempts === 1 ? '' : 's'}</span>
        <span>${execution.startedAt ? text(new Date(execution.startedAt).toLocaleString()) : 'time unavailable'}</span>
        <span>${text(execution.location.file)}:${text(execution.location.line)}</span>
      </div>
      ${evidenceContext(execution)}
      ${errors || processOutput || attemptHistory || annotations ? `<div class="context-grid">${errors}${processOutput}${attemptHistory}${annotations}</div>` : ''}
      <h4>Evidence files</h4>${media}
    </article>`;
  }

  function cardHtml(audit) {
    const searchText = [
      audit.id,
      audit.definition.title,
      audit.definition.userPromise,
      audit.definition.expected,
      audit.reason,
      ...audit.findings.flatMap((finding) => [finding.title, finding.detail]),
    ].join(' ').toLowerCase();
    return `<details class="audit-card" data-id="${text(audit.id)}" data-status="${text(audit.status)}" data-area="${text(audit.definition.area)}" data-severity="${text(audit.definition.severity)}" data-blocking="${audit.definition.releaseBlocking}" data-baseline-issue="${audit.baseline.hasIssues}" data-environments="${text(Object.entries(audit.coverage).filter(([key, value]) => ['production', 'candidate', 'unknown'].includes(key) && value > 0).map(([key]) => key).join(' '))}" data-search="${escapeHtml(searchText)}">
      <summary>
        <span class="audit-heading"><code>${text(audit.id)}</code><span class="audit-title">${text(audit.definition.title)}</span></span>
        <span class="badges">${badge(audit.status, `status-${audit.status}`)}${badge(audit.definition.severity)}${audit.definition.releaseBlocking ? badge('release gate') : ''}${audit.manual ? badge('manual') : ''}${audit.evidenceCounts.video ? badge(`${audit.evidenceCounts.video} video${audit.evidenceCounts.video === 1 ? '' : 's'}`) : ''}</span>
      </summary>
      <div class="audit-body">
        <p><strong>Candidate release assessment:</strong> ${text(audit.reason)}</p>
        ${audit.baseline.hasIssues ? `<p class="baseline-note"><strong>Production baseline:</strong> ${text(audit.baseline.note)}</p>` : ''}
        <div class="audit-intent">
          <section class="intent-card"><h3>User promise</h3><p>${text(audit.definition.userPromise)}</p></section>
          <section class="intent-card"><h3>Expected outcome</h3><p>${text(audit.definition.expected)}</p></section>
          <section class="intent-card"><h3>Coverage and evidence contract</h3><p>Candidate: ${audit.coverage.candidate} (${text(audit.environmentStatus.candidate)})<br>Production: ${audit.coverage.production} (${text(audit.environmentStatus.production)})<br>Unknown: ${audit.coverage.unknown} (${text(audit.environmentStatus.unknown)})<br>Projects: ${text(audit.coverage.projects.join(', '))}<br>Required: ${text(audit.definition.evidence.join(', '))}<br>Gate: ${audit.crossEnvironmentGate ? 'explicit cross-environment contract' : 'candidate evidence'}</p></section>
        </div>
        ${audit.executions.length ? audit.executions.map(executionHtml).join('') : '<p class="empty">This check has no automated evidence in this run. It remains visible so missing coverage cannot masquerade as success.</p>'}
      </div>
    </details>`;
  }

  function populateSelect(select, values) {
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
  }

  function renderHeader() {
    const run = manifest.run;
    document.getElementById('run-context').textContent = `${run.profile} profile · ${run.source} · generated ${new Date(manifest.generatedAt).toLocaleString()} · ${formatDuration(run.durationMs)}`;
    const decision = document.getElementById('release-decision');
    decision.innerHTML = `<strong>${text(manifest.release.decision.replace('_', ' '))}</strong><span>${text(manifest.release.reason)}</span><small>${text(manifest.release.decisionBasis)}</small>`;
    decision.dataset.ready = String(manifest.release.ready);
    const cards = [
      [manifest.summary.total, 'catalog checks'],
      [manifest.summary.executed, 'checks executed'],
      [manifest.summary.byStatus.PASS, 'validated passes'],
      [manifest.summary.byStatus.FAIL, 'failures'],
      [manifest.summary.byStatus.REVIEW, 'need review'],
      [manifest.summary.byStatus.NOT_RUN + manifest.summary.byStatus.MANUAL_REQUIRED, 'incomplete'],
      [manifest.summary.videos, 'videos'],
      ...(manifest.summary.posters ? [[manifest.summary.posters, 'video posters']] : []),
      [manifest.summary.artifacts, 'evidence files'],
      [manifest.summary.baselineIssues, 'baseline issues'],
    ];
    document.getElementById('summary').innerHTML = cards.map(([value, label]) => `<article class="summary-card"><strong>${text(value)}</strong><span>${text(label)}</span></article>`).join('');
  }

  function applyFilters() {
    const query = controls.search.value.trim().toLowerCase();
    let visible = 0;
    for (const card of list.querySelectorAll('.audit-card')) {
      const show = (!query || card.dataset.search.includes(query))
        && (!controls.status.value || card.dataset.status === controls.status.value)
        && (!controls.area.value || card.dataset.area === controls.area.value)
        && (!controls.severity.value || card.dataset.severity === controls.severity.value)
        && (!controls.environment.value || card.dataset.environments.split(' ').includes(controls.environment.value))
        && (!controls.blocking.checked || card.dataset.blocking === 'true')
        && (!controls.baseline.checked || card.dataset.baselineIssue === 'true');
      card.hidden = !show;
      if (show) visible += 1;
    }
    document.getElementById('result-count').textContent = `Showing ${visible} of ${manifest.audits.length} audit checks.`;
  }

  function renderDiagnostics() {
    const section = document.getElementById('run-diagnostics');
    const hasContent = manifest.warnings.length || manifest.unmappedTests.length || manifest.run.errors.length;
    section.innerHTML = `<h2 id="diagnostics-heading">Run diagnostics</h2>${hasContent ? '' : '<p>No report-generation warnings or unmapped tests.</p>'}
      ${manifest.warnings.length ? `<h3>Evidence warnings</h3>${jsonBlock(manifest.warnings)}` : ''}
      ${manifest.unmappedTests.length ? `<h3>Unmapped tests</h3><p>These tests ran but did not declare an audit ID and cannot satisfy a checklist row.</p>${jsonBlock(manifest.unmappedTests.map((test) => ({ title: test.title, project: test.projectName, file: test.file })))}` : ''}
      ${manifest.run.errors.length ? `<h3>Run errors</h3>${jsonBlock(manifest.run.errors)}` : ''}`;
  }

  async function renderAiReview() {
    const state = document.getElementById('ai-review-state');
    try {
      const response = await fetch('../ai-review/review.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('not generated');
      const review = await response.json();
      const findings = Array.isArray(review.review?.findings) ? review.review.findings.length : 0;
      state.innerHTML = `<a href="../ai-review/index.html">Open AI evidence review</a> · ${text(review.status)} · ${findings} advisory finding${findings === 1 ? '' : 's'} · model ${text(review.model)}.`;
    } catch {
      state.textContent = 'Not generated for this run. The Playwright evidence and human checklist remain authoritative.';
    }
  }

  renderHeader();
  list.innerHTML = manifest.audits.map(cardHtml).join('');
  populateSelect(controls.status, Object.keys(manifest.summary.byStatus));
  populateSelect(controls.area, Object.keys(manifest.summary.byArea).sort());
  populateSelect(controls.severity, Object.keys(manifest.summary.bySeverity).sort());
  renderDiagnostics();
  void renderAiReview();
  Object.values(controls).forEach((control) => control.addEventListener(control.type === 'search' ? 'input' : 'change', applyFilters));
  document.getElementById('clear-filters').addEventListener('click', () => {
    controls.search.value = '';
    controls.status.value = '';
    controls.area.value = '';
    controls.severity.value = '';
    controls.environment.value = '';
    controls.blocking.checked = false;
    controls.baseline.checked = false;
    applyFilters();
    controls.search.focus();
  });
  document.getElementById('expand-visible').addEventListener('click', (event) => {
    const visibleCards = [...list.querySelectorAll('.audit-card:not([hidden])')];
    const shouldOpen = visibleCards.some((card) => !card.open);
    for (const card of visibleCards) card.open = shouldOpen;
    event.currentTarget.textContent = shouldOpen ? 'Collapse visible' : 'Expand visible';
  });
  applyFilters();
})();
