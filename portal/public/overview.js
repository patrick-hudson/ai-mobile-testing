import { mountConsoleIndexPage, field, formatTime, runHref } from './console-index-page.js';
import { overviewRefreshInterval } from './console-index-refresh.js';

const root = document.getElementById('overview-console');
if (root) mountConsoleIndexPage({
  rootId: 'overview-console',
  routeId: 'overview',
  title: 'Overview',
  description: 'A bounded operational view of product risk and independently sourced run trust.',
  filters: [
    { name: 'mode', label: 'Audit mode', type: 'select', options: [
      { value: 'all', label: 'All modes' }, { value: 'comparative', label: 'Comparative' }, { value: 'single-site', label: 'Single-site' },
    ] },
    { name: 'scope', label: 'Scope key', type: 'search', placeholder: 'all', maximum: 160 },
    { name: 'view', label: 'View', type: 'select', options: [
      { value: 'attention', label: 'Attention' }, { value: 'all', label: 'All bounded facts' },
    ] },
  ],
  query: (state) => ({ mode: state.mode, scope: state.scope ?? 'all', sort: 'attention', limit: 100 }),
  refreshIntervalFor: overviewRefreshInterval,
  renderContent: renderOverview,
  renderInspector: () => undefined,
  emptyText: 'No indexed runs or attention records exist for this scope.',
});

function renderOverview({ document, content, result, state }) {
  const records = result.page.items;
  const view = overviewView(records, result.page);
  const layout = document.createElement('div');
  layout.className = 'overview-layout';
  layout.append(
    riskSection(document, view.risk, result.page, view.riskState),
    trustSection(document, view.latest, view.trust, view.trustState),
    runSection(document, view.active, result.page.capabilities),
    latestSection(document, view.latest, view.predecessor),
  );
  if (view.metrics.length > 0 || state.view === 'all') layout.append(metricsSection(document, view.metrics, result.page));
  content.append(layout);
}

function overviewView(records, page) {
  const projection = page.overview;
  const lookup = new Map(records.map((record) => [referenceKey(record), record]));
  const resolve = (reference) => reference ? lookup.get(referenceKey(reference)) ?? null : null;
  if (projection) {
    return {
      risk: projection.productRisk.items.map(resolve).filter(Boolean),
      riskState: projection.productRisk.state,
      trust: projection.runTrust.facts.map(resolve).filter(Boolean),
      trustState: projection.runTrust.state,
      active: projection.activeRuns.items.map(resolve).filter(Boolean),
      latest: resolve(projection.latestTerminalRun),
      predecessor: {
        available: projection.comparablePredecessor.available,
        record: resolve(projection.comparablePredecessor.record),
        historyComplete: projection.comparablePredecessor.historyComplete,
        reason: projection.comparablePredecessor.reason,
      },
      metrics: projection.statistics.map(resolve).filter(Boolean).slice(0, 6),
    };
  }
  const runs = records.filter(({ recordType }) => recordType === 'run');
  const risk = records.filter(({ recordType }) => ['risk', 'attention'].includes(recordType));
  const trust = records.filter(({ recordType }) => recordType === 'trust');
  const metrics = records.filter(({ recordType }) => recordType === 'metric').slice(0, 6);
  const active = runs.filter((record) => field(record, 'terminal', false) !== true).slice(0, 8);
  const terminal = runs.filter((record) => field(record, 'terminal', false) === true).sort((left, right) => timestamp(right) - timestamp(left));
  const latest = terminal[0] ?? null;
  const predecessor = latest ? terminal.find((record) => record !== latest && record.mode === latest.mode && record.scopeKey === latest.scopeKey) ?? null : null;
  return {
    risk,
    riskState: null,
    trust: trust.filter((record) => !latest || record.runId === latest.runId),
    trustState: null,
    active,
    latest,
    predecessor: {
      available: predecessor !== null,
      record: predecessor,
      historyComplete: page.complete && !page.hasMore,
      reason: predecessor ? 'matched' : 'no-compatible-history',
    },
    metrics,
  };
}

function riskSection(document, records, page, state) {
  const section = region(document, 'Product Risk', 'overview-risk');
  if (records.length === 0) {
    const text = document.createElement('p');
    text.className = 'overview-empty';
    text.textContent = state?.reason ?? (page.complete && !page.hasMore
      ? 'No attention records are indexed for this filter. This is a factual queue state, not a pass verdict.'
      : 'No attention records are present in this incomplete bounded page.');
    section.append(text);
    return section;
  }
  const list = document.createElement('ol');
  list.className = 'overview-risk-list';
  for (const record of records.slice(0, 12)) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    const parameters = new URLSearchParams({ mode: record.mode, record: record.recordId, inspector: 'open' });
    link.href = `/findings.html?${parameters.toString()}`;
    link.textContent = field(record, 'title', record.recordId);
    const factors = document.createElement('span');
    factors.textContent = [
      field(record, 'attentionKind', field(record, 'sourceKind', record.recordType)),
      field(record, 'severity', null),
      field(record, 'blocking', null) === true ? 'blocking' : field(record, 'blocking', null) === false ? 'non-blocking' : 'blocking intent unavailable',
      field(record, 'novelty', null) ?? 'novelty unavailable',
      field(record, 'affectedScope', null) ?? 'scope unavailable',
      unresolvedAge(record),
      `identity ${record.recordId}`,
      `source ${record.sourceId}`,
    ].filter(Boolean).join(' · ');
    item.append(link, factors);
    list.append(item);
  }
  section.append(list);
  return section;
}

function trustSection(document, latest, records, state) {
  const section = region(document, 'Run Trust', 'overview-trust');
  if (!latest && records.length === 0) {
    const text = document.createElement('p');
    text.textContent = state?.reason ?? 'Run trust is unavailable because no bounded terminal run is indexed.';
    section.append(text);
    return section;
  }
  const definition = document.createElement('dl');
  definition.className = 'console-definition-list overview-trust-facts';
  if (records.length > 0) {
    for (const record of records) {
      const term = document.createElement('dt');
      const destination = recordDestination(record);
      if (destination) {
        const link = document.createElement('a'); link.href = destination; link.textContent = field(record, 'title', record.recordId); term.append(link);
      } else term.textContent = field(record, 'title', record.recordId);
      const detail = document.createElement('dd');
      const status = field(record, 'status');
      detail.textContent = `${status} · ${trustSupport(status)} · ${record.complete ? 'complete source' : 'limited source'} · ${formatTime(field(record, 'sourceTimestamp', record.sourceUpdatedAt))} · ${record.sourceId}`;
      definition.append(term, detail);
    }
  } else if (latest) {
    for (const [label, name] of [
      ['Coverage', 'coverageStatus'], ['Evidence authority', 'evidenceAuthorityStatus'], ['Evidence completion', 'evidenceCompletionStatus'],
      ['Pipeline integrity', 'pipelineIntegrityStatus'], ['Finalization', 'finalizationStatus'], ['Manual acceptance', 'manualStatus'],
    ]) {
      const term = document.createElement('dt'); term.textContent = label;
      const detail = document.createElement('dd'); detail.textContent = field(latest, name);
      definition.append(term, detail);
    }
  }
  section.append(definition);
  return section;
}

function runSection(document, records, capabilities) {
  const section = region(document, 'Active runs', 'overview-active-runs');
  if (records.length === 0) {
    const text = document.createElement('p'); text.textContent = 'No active runs are present in this bounded snapshot.'; section.append(text); return section;
  }
  const table = document.createElement('table'); table.className = 'console-data-table overview-active-table';
  const head = document.createElement('thead'); const heading = document.createElement('tr');
  for (const label of ['Run', 'Execution', 'Activity', 'Transport', 'Progress / elapsed', 'Stage / shard', 'Server update', 'Scope', 'Provisional findings', 'Actions']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; heading.append(cell);
  }
  head.append(heading);
  const body = document.createElement('tbody');
  for (const record of records) {
    const row = document.createElement('tr');
    const runCell = document.createElement('td'); const link = document.createElement('a'); link.href = runHref(record); link.textContent = field(record, 'title', record.runId); runCell.append(link);
    const executionCell = document.createElement('td'); executionCell.textContent = field(record, 'executionState');
    const activityCell = document.createElement('td'); activityCell.textContent = field(record, 'activityState');
    const transportCell = document.createElement('td'); transportCell.textContent = 'Snapshot only; live transport in workspace';
    const progressCell = document.createElement('td'); progressCell.textContent = runProgress(record);
    const stageCell = document.createElement('td'); stageCell.textContent = [field(record, 'phase', null), field(record, 'stageId', null), field(record, 'shardId', null)].filter(Boolean).join(' / ') || 'Unavailable';
    const updateCell = document.createElement('td'); updateCell.textContent = formatTime(field(record, 'updatedAt', record.sourceUpdatedAt));
    const scopeCell = document.createElement('td'); scopeCell.textContent = field(record, 'scopeLabel', record.scopeKey);
    const findingsCell = document.createElement('td');
    const findingCount = field(record, 'findingCount', null);
    if (Number.isSafeInteger(findingCount)) {
      const findingLink = document.createElement('a');
      findingLink.href = `/findings.html?${new URLSearchParams({ mode: record.mode, run: record.runId }).toString()}`;
      findingLink.textContent = `${findingCount} provisional`;
      findingsCell.append(findingLink);
    } else findingsCell.textContent = 'Unavailable';
    const actionsCell = document.createElement('td'); actionsCell.className = 'overview-run-actions'; actionsCell.append(runActionLinks(document, record, capabilities));
    row.append(runCell, executionCell, activityCell, transportCell, progressCell, stageCell, updateCell, scopeCell, findingsCell, actionsCell); body.append(row);
  }
  table.append(head, body);
  const scroll = document.createElement('div'); scroll.className = 'console-table-scroll overview-active-scroll'; scroll.append(table);
  section.append(scroll); return section;
}

function latestSection(document, latest, predecessor) {
  const section = region(document, 'Latest terminal run', 'overview-latest');
  if (!latest) { const text = document.createElement('p'); text.textContent = 'No terminal run is present in this bounded snapshot.'; section.append(text); return section; }
  const link = document.createElement('a'); link.href = runHref(latest); link.textContent = field(latest, 'title', latest.runId);
  const facts = document.createElement('dl'); facts.className = 'console-definition-list overview-latest-facts';
  for (const [label, value] of [
    ['Outcome', field(latest, 'outcome')], ['Finalization', field(latest, 'finalizationStatus')], ['Coverage', field(latest, 'coverageStatus')],
    ['Evidence authority', field(latest, 'evidenceAuthorityStatus')], ['Pipeline integrity', field(latest, 'pipelineIntegrityStatus')],
    ['Completed', formatTime(field(latest, 'finishedAt', null))],
  ]) {
    const term = document.createElement('dt'); term.textContent = label; const detail = document.createElement('dd'); detail.textContent = String(value); facts.append(term, detail);
  }
  const comparison = document.createElement('p');
  comparison.textContent = predecessor.available && predecessor.record
    ? `Comparable predecessor: ${field(predecessor.record, 'title', predecessor.record.runId)}.`
    : predecessor.historyComplete
      ? 'No valid comparable predecessor is available; no novelty or regression claim is made.'
      : 'Comparable history is bounded or incomplete; no novelty or regression claim is made.';
  section.append(link, facts, comparison); return section;
}

function metricsSection(document, records, page) {
  const section = region(document, 'Statistics and provenance', 'overview-metrics');
  section.classList.add('overview-wide');
  if (records.length === 0) {
    const text = document.createElement('p');
    text.textContent = page.complete ? 'No computed statistics are indexed.' : 'Metric provenance is not available in the incomplete bounded index.';
    section.append(text); return section;
  }
  const table = document.createElement('table'); table.className = 'console-data-table';
  const head = document.createElement('thead'); const hr = document.createElement('tr');
  for (const label of ['Statistic', 'Value', 'Population / source', 'As of']) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; hr.append(th); }
  head.append(hr); const body = document.createElement('tbody');
  for (const record of records.slice(0, 6)) {
    const row = document.createElement('tr');
    const title = document.createElement('td');
    const destination = metricDestination(record);
    if (destination) { const link = document.createElement('a'); link.href = destination; link.textContent = field(record, 'title', record.recordId); title.append(link); }
    else {
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = field(record, 'title', record.recordId);
      const provenance = document.createElement('p'); provenance.textContent = `${field(record, 'detail')} · source ${record.sourceId} · ${record.complete ? 'complete' : 'partial'}`;
      details.append(summary, provenance); title.append(details);
    }
    const value = document.createElement('td'); value.textContent = metricValue(record);
    const population = document.createElement('td'); population.textContent = `${field(record, 'subtitle', 'Population unavailable')} · ${record.sourceId}`;
    const time = document.createElement('td'); time.textContent = `${formatTime(field(record, 'sourceTimestamp', record.sourceUpdatedAt))} · ${record.complete ? 'current' : 'limited'}`;
    row.append(title, value, population, time);
    body.append(row);
  }
  table.append(head, body); section.append(table); return section;
}

function region(document, title, id) {
  const section = document.createElement('section'); section.id = id; section.className = 'overview-panel'; section.setAttribute('aria-labelledby', `${id}-title`);
  const heading = document.createElement('h2'); heading.id = `${id}-title`; heading.textContent = title; section.append(heading); return section;
}

function timestamp(record) {
  const value = Date.parse(field(record, 'finishedAt', field(record, 'updatedAt', record.sourceUpdatedAt)));
  return Number.isFinite(value) ? value : 0;
}

function referenceKey(value) { return `${value.mode}\u241f${value.runId}\u241f${value.recordId}`; }

function runProgress(record) {
  const completed = field(record, 'progressCompleted', null);
  const total = field(record, 'progressTotal', null);
  const elapsed = elapsedDuration(field(record, 'startedAt', null), field(record, 'updatedAt', record.sourceUpdatedAt));
  return `${completed ?? '?'} / ${total ?? '?'} · ${elapsed}`;
}

function elapsedDuration(startedAt, endedAt) {
  const start = Date.parse(startedAt ?? ''); const end = Date.parse(endedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'elapsed unavailable';
  return `${Math.max(0, Math.round((end - start) / 60_000))}m elapsed`;
}

function runActionLinks(document, record, capabilities) {
  const container = document.createElement('div');
  const open = document.createElement('a'); open.href = runHref(record); open.textContent = 'Open'; container.append(open);
  const capability = capabilities?.items?.find((entry) => entry.identity?.mode === record.mode && entry.identity?.runId === record.runId);
  const expectedAction = record.mode === 'single-site' ? 'cancel' : 'stop';
  const mutation = capability?.actions?.find(({ actionId }) => actionId === expectedAction);
  const button = document.createElement('button'); button.type = 'button'; button.disabled = true;
  button.textContent = expectedAction === 'cancel' ? 'Cancel in workspace' : 'Stop in workspace';
  button.title = mutation?.available
    ? 'Open the immutable run workspace to confirm this action.'
    : mutation?.unavailableReason ?? 'Capability snapshot unavailable; open the workspace to refresh eligibility.';
  const retry = document.createElement('button'); retry.type = 'button'; retry.disabled = true; retry.textContent = 'Retry unavailable';
  retry.title = 'This run authority does not expose a retry mutation from the Overview.';
  container.append(button, retry);
  return container;
}

function metricValue(record) {
  for (const name of ['progressTotal', 'durationMs', 'progressFlaky', 'findingCount', 'manualOutstanding', 'baselineIssues', 'visualAttentionRequired']) {
    if (record.fields[name] !== undefined && record.fields[name] !== null) return String(record.fields[name]);
  }
  return 'Unavailable';
}

function metricDestination(record) {
  const destinations = Array.isArray(record.fields.destinations) ? record.fields.destinations : [];
  return destinations.find((value) => typeof value === 'string' && /^\/(?:runs|findings|evidence)\.html\?(?!.*(?:authorization|token|secret))/u.test(value)) ?? null;
}

function recordDestination(record) {
  const destinations = Array.isArray(record.fields.destinations) ? record.fields.destinations : [];
  return destinations.find((value) => typeof value === 'string' && /^\/(?:report|run|findings|evidence)\.html\?(?!.*(?:authorization|token|secret))/u.test(value)) ?? null;
}

function trustSupport(status) {
  if (/^(?:complete|completed|passed|ready|authoritative|supported|healthy|success)$/iu.test(String(status))) return 'supported conclusion';
  if (/^(?:partial|limited|warning|pending|running|incomplete|degraded|outstanding)$/iu.test(String(status))) return 'limited conclusion';
  if (/^(?:failed|failure|blocked|invalid|unavailable|non-authoritative)$/iu.test(String(status))) return 'conclusion unavailable';
  return 'support unknown';
}

function unresolvedAge(record) {
  const since = Date.parse(field(record, 'unresolvedAt', ''));
  const asOf = Date.parse(field(record, 'sourceTimestamp', record.sourceUpdatedAt));
  if (!Number.isFinite(since) || !Number.isFinite(asOf) || asOf < since) return 'age unavailable';
  const hours = Math.floor((asOf - since) / 3_600_000);
  return hours < 24 ? `${hours}h unresolved` : `${Math.floor(hours / 24)}d unresolved`;
}
