(() => {
  'use strict';

  const AVAILABILITY = new Set(['LOADING', 'PROVISIONAL', 'AVAILABLE', 'PARTIAL', 'EMPTY', 'UNAVAILABLE']);
  const SEVERITY = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
  const OPERATIONAL = new Set(['certificate-bypass', 'evidence-pipeline-limitation']);

  function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('The embedded shared release publication contains a non-canonical value.');
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }

  async function canonicalDigest(value) {
    if (!globalThis.crypto?.subtle) throw new TypeError('SHA-256 validation is unavailable in this archive viewer.');
    const bytes = new TextEncoder().encode(canonicalJson(value));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function requiredText(value, label, maximum = 8_000) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new TypeError(`${label} is invalid.`);
    }
    return value;
  }

  function requireProjection(value) {
    const publication = value?.publication;
    const revisions = value?.revisions;
    const decision = value?.decision;
    const register = value?.riskRegister;
    if (!value || value.schemaVersion !== 1
      || typeof publication?.runId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(publication?.envelopeDigest ?? '')
      || !Number.isSafeInteger(revisions?.run) || revisions.run < 1
      || !Number.isSafeInteger(revisions?.decision) || revisions.decision < 1
      || !Number.isSafeInteger(revisions?.risk) || revisions.risk < 1
      || !AVAILABILITY.has(register?.availability) || !Array.isArray(register?.risks)
      || typeof decision?.label !== 'string' || typeof decision?.grantedAuthority !== 'string') {
      throw new TypeError('The embedded shared release publication is invalid.');
    }
    if ((['LOADING', 'EMPTY', 'UNAVAILABLE'].includes(register.availability) && register.risks.length !== 0)
      || (register.availability === 'AVAILABLE' && register.risks.length === 0)) {
      throw new TypeError('The embedded Risk Register availability is inconsistent.');
    }
    for (const risk of register.risks) {
      requiredText(risk?.identity, 'Risk identity');
      requiredText(risk?.category, 'Risk category');
      requiredText(risk?.severity, 'Risk severity');
      requiredText(risk?.reviewState, 'Risk review state');
      requiredText(risk?.explanation, 'Risk explanation');
      requiredText(risk?.recommendedAction, 'Risk recommended action');
      if (risk.releaseEffect !== 'non-blocking') throw new TypeError('Archive risks must remain non-blocking.');
    }
    return value;
  }

  function element(documentObject, tag, text, className = '') {
    const node = documentObject.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(text ?? '');
    return node;
  }

  function humanize(value) {
    return String(value ?? '').replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function scopeSummary(value) {
    if (Array.isArray(value)) return value.join(', ') || 'No scope values published';
    if (!value || typeof value !== 'object') return String(value ?? 'No certified scope published');
    return [
      ...(value.features ?? []).map((entry) => `feature ${entry}`),
      ...(value.definitions ?? []).map((entry) => `definition ${entry}`),
      ...(value.targets ?? []).map((entry) => `target ${entry}`),
      ...(value.knownLimits ?? value.limitations ?? []).map((entry) => `limit ${entry}`),
    ].join(' · ') || 'No scope values published';
  }

  function availabilityCopy(availability, count) {
    if (availability === 'EMPTY') return 'EMPTY · Register complete; no active product risks were published.';
    if (availability === 'AVAILABLE') return `AVAILABLE · ${count} published risk record${count === 1 ? '' : 's'}.`;
    if (availability === 'PROVISIONAL') return `PROVISIONAL · ${count} risk record${count === 1 ? '' : 's'} published; this sealed snapshot may not contain later review.`;
    if (availability === 'PARTIAL') return `PARTIAL · ${count} risk record${count === 1 ? '' : 's'} published; missing rows cannot be treated as no risk.`;
    if (availability === 'LOADING') return 'LOADING · Risk publication was not complete at export; no no-risk claim can be made.';
    return 'UNAVAILABLE · Risk publication was unavailable at export; no no-risk claim can be made.';
  }

  function orderedRisks(risks) {
    return [...risks].sort((left, right) => {
      const severity = (SEVERITY[left.severity] ?? 99) - (SEVERITY[right.severity] ?? 99);
      if (severity) return severity;
      const operational = Number(OPERATIONAL.has(left.category)) - Number(OPERATIONAL.has(right.category));
      return operational || left.identity.localeCompare(right.identity);
    });
  }

  function riskTable(documentObject, risks) {
    const wrapper = documentObject.createElement('div');
    wrapper.className = 'archive-risk-table-wrap';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Bounded Product Risk register');
    const table = documentObject.createElement('table');
    table.className = 'archive-risk-table';
    const head = documentObject.createElement('thead');
    const headRow = documentObject.createElement('tr');
    for (const label of ['Risk', 'Severity', 'Scope', 'Review', 'Release effect', 'Recommended action']) {
      const heading = element(documentObject, 'th', label);
      heading.scope = 'col';
      headRow.append(heading);
    }
    head.append(headRow);
    const body = documentObject.createElement('tbody');
    for (const risk of orderedRisks(risks).slice(0, 200)) {
      const row = documentObject.createElement('tr');
      const riskCell = documentObject.createElement('td');
      riskCell.append(element(documentObject, 'strong', humanize(risk.category)), element(documentObject, 'span', risk.explanation));
      row.append(
        riskCell,
        element(documentObject, 'td', risk.severity.toUpperCase()),
        element(documentObject, 'td', scopeSummary(risk.scope)),
        element(documentObject, 'td', humanize(risk.reviewState)),
        element(documentObject, 'td', `${risk.releaseEffect} · never changes the decision`),
        element(documentObject, 'td', risk.recommendedAction),
      );
      body.append(row);
    }
    table.append(head, body);
    wrapper.append(table);
    return wrapper;
  }

  async function render(documentObject = document) {
    const node = documentObject.querySelector('#shared-release-publication');
    const root = documentObject.querySelector('#archive-product-risk');
    if (!node || !root) return null;
    let projection;
    try {
      projection = requireProjection(JSON.parse(node.textContent ?? 'null'));
      const descriptor = JSON.parse(documentObject.querySelector('#gallery-archive-head')?.textContent ?? 'null');
      const expectedDigest = requiredText(descriptor?.releasePublicationDigest, 'Shared release projection digest', 80);
      if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest) || await canonicalDigest(projection) !== expectedDigest) {
        throw new TypeError('The embedded shared release publication failed its revision-bound digest check.');
      }
    } catch (error) {
      root.dataset.riskAvailability = 'UNAVAILABLE';
      root.removeAttribute('aria-busy');
      const status = documentObject.querySelector('#archive-risk-status');
      if (status) status.textContent = `UNAVAILABLE · ${error instanceof Error ? error.message : 'Shared release publication is invalid.'}`;
      root.querySelector('#archive-authority-content')?.replaceChildren(
        element(documentObject, 'h3', 'Shared release authority unavailable'),
        element(documentObject, 'p', 'Legacy evidence remains readable but cannot substitute for a valid revision-bound publication.'),
      );
      return Object.freeze({ unavailable: true });
    }
    const { decision, riskRegister, revisions, publication } = projection;
    root.dataset.riskAvailability = riskRegister.availability;
    root.removeAttribute('aria-busy');
    documentObject.querySelector('#archive-risk-status').textContent = availabilityCopy(riskRegister.availability, riskRegister.risks.length);
    const content = documentObject.querySelector('#archive-authority-content');
    const decisionCard = documentObject.createElement('section');
    decisionCard.className = 'archive-authority-decision';
    const revisionCopy = element(documentObject, 'p', `Decision revision ${revisions.decision} · Run revision ${revisions.run} · Risk revision ${revisions.risk}`);
    revisionCopy.id = 'archive-authority-revisions';
    decisionCard.append(
      element(documentObject, 'p', 'Release Decision', 'archive-authority-eyebrow'),
      element(documentObject, 'h3', decision.label),
      element(documentObject, 'p', `${decision.code ?? decision.label.replaceAll(' ', '_')} · ${decision.grantedAuthority} authority`),
      element(documentObject, 'p', scopeSummary(decision.certifiedScope), 'archive-certified-scope'),
      revisionCopy,
      element(documentObject, 'p', decision.superseded
        ? 'SUPERSEDED · This historical decision cannot authorize release.'
        : `Pinned publication ${publication.envelopeDigest.slice(0, 18)}… · This archive is evidence, not a live promotion claim.`),
    );
    const register = documentObject.createElement('section');
    register.id = 'archive-risk-register';
    register.className = 'archive-risk-register';
    register.append(element(documentObject, 'h3', 'Risk Register'));
    if (riskRegister.availability === 'EMPTY') register.append(element(documentObject, 'p', 'The complete register contains no active product risks.'));
    else if (riskRegister.risks.length === 0) register.append(element(documentObject, 'p', `${riskRegister.availability} risk data contains no published rows. This is not a no-risk claim.`));
    else register.append(riskTable(documentObject, riskRegister.risks));
    const offline = documentObject.createElement('section');
    offline.className = 'archive-operation-context';
    offline.append(
      element(documentObject, 'h3', 'Offline operation context'),
      element(documentObject, 'p', 'This sealed archive has no live recovery stream or mutation controls. Open the current run workspace to inspect later operations and revisions.'),
    );
    content.replaceChildren(decisionCard, register, offline);
    return projection;
  }

  globalThis.Quitting7ohArchiveRelease = Object.freeze({ requireProjection, canonicalDigest, render });
})();
