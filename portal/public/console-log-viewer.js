const DEFAULT_MAX_RECORDS = 2_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_PENDING_RECORDS = 500;
const DEFAULT_PENDING_BYTES = 128 * 1024;
const encoder = new TextEncoder();

function boundedText(value, maximum = 20_000) {
  return typeof value === 'string'
    ? value.replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, maximum)
    : '';
}

export function redactConsoleLogText(value) {
  return boundedText(value)
    .replace(/sk-ant-[a-zA-Z0-9_-]+/gu, '[REDACTED]')
    .replace(/\b(authorization|x-api-key)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/giu, '$1 [REDACTED]');
}

function byteLength(record) {
  return encoder.encode(JSON.stringify(record)).byteLength;
}

function safeTimestamp(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeToken(value, fallback = 'unknown') {
  const normalized = boundedText(value, 120).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,119}$/u.test(normalized) ? normalized : fallback;
}

function normalizeRecord(input, fallbackId) {
  const sequence = Number.isSafeInteger(input?.sequence) && input.sequence >= 0 ? input.sequence : null;
  const message = redactConsoleLogText(input?.message ?? input?.line ?? '');
  if (!message) return null;
  const identity = sequence === null ? `local:${fallbackId}` : `sequence:${sequence}`;
  return Object.freeze({
    identity,
    sequence,
    timestamp: safeTimestamp(input?.timestamp),
    source: safeToken(input?.source ?? input?.channel),
    stage: safeToken(input?.stage),
    shard: safeToken(input?.shard),
    context: safeToken(input?.context, 'output'),
    message,
  });
}

export function parseConsoleLogTail(text, { mode = 'comparative', startingIdentity = 0 } = {}) {
  const lines = boundedText(text, DEFAULT_MAX_BYTES * 2).split(/\r?\n/u);
  const records = [];
  for (const [offset, line] of lines.entries()) {
    if (!line) continue;
    if (mode === 'single-site' && line.startsWith('{')) {
      try {
        const event = JSON.parse(line);
        const detail = event?.detail && typeof event.detail === 'object' ? event.detail : event;
        const record = normalizeRecord({
          sequence: event.sequence,
          timestamp: event.timestamp ?? event.at,
          source: detail.channel ?? 'worker',
          stage: detail.stage ?? event.event ?? event.type,
          shard: detail.shardId,
          context: event.event ?? event.type ?? 'worker-event',
          message: detail.line ?? detail.message ?? line,
        }, startingIdentity + offset);
        if (record) records.push(record);
        continue;
      } catch {
        // Preserve malformed authority output as labelled text, never inferred state.
      }
    }
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+\[([^:\]]+):([^\]]+)\]\s?(.*)$/u);
    const external = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+\[([^\]]+)\]\s?(.*)$/u);
    const record = normalizeRecord(match ? {
      timestamp: match[1], stage: match[2], source: match[3], message: match[4], context: 'runner',
    } : external ? {
      timestamp: external[1], stage: external[2], source: 'runner', message: external[3], context: 'external',
    } : {
      source: mode === 'single-site' ? 'worker' : 'runner', message: line, context: 'unstructured',
    }, startingIdentity + offset);
    if (record) records.push(record);
  }
  return records;
}

export function createConsoleLogBuffer({
  maxRecords = DEFAULT_MAX_RECORDS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  let records = [];
  let bytes = 0;
  let dropped = 0;
  let localIdentity = 0;
  const sequenceIds = new Set();

  function trim() {
    while (records.length > maxRecords || bytes > maxBytes) {
      const removed = records.shift();
      if (!removed) break;
      bytes = Math.max(0, bytes - byteLength(removed));
      if (removed.sequence !== null) sequenceIds.delete(removed.sequence);
      dropped += 1;
    }
  }

  function append(input) {
    const record = normalizeRecord(input, ++localIdentity);
    if (!record || (record.sequence !== null && sequenceIds.has(record.sequence))) return false;
    records.push(record);
    bytes += byteLength(record);
    if (record.sequence !== null) sequenceIds.add(record.sequence);
    trim();
    return true;
  }

  function replace(nextRecords) {
    records = [];
    bytes = 0;
    dropped = 0;
    sequenceIds.clear();
    for (const record of nextRecords) append(record);
    return snapshot();
  }

  function snapshot() {
    return Object.freeze({
      records: Object.freeze([...records]),
      bytes,
      dropped,
      maxRecords,
      maxBytes,
    });
  }

  return Object.freeze({
    append,
    replace,
    hasSequence(sequence) { return Number.isSafeInteger(sequence) && sequenceIds.has(sequence); },
    get snapshot() { return snapshot(); },
  });
}

function option(document, value) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = value === 'all' ? 'All' : value;
  return node;
}

export function createConsoleLogViewer({ root, mode, announce, initialFilters = {}, onFiltersChange } = {}) {
  if (!(root instanceof Element)) throw new TypeError('Log viewer requires a root element.');
  const document = root.ownerDocument;
  const buffer = createConsoleLogBuffer();
  const pendingBuffer = createConsoleLogBuffer({ maxRecords: DEFAULT_PENDING_RECORDS, maxBytes: DEFAULT_PENDING_BYTES });
  let auditMode = mode;
  let paused = false;
  let pausedRecords = [];
  let pendingWindowDropped = 0;
  let filters = {
    search: boundedText(initialFilters.search, 300),
    source: safeToken(initialFilters.source, 'all'),
    stage: safeToken(initialFilters.stage, 'all'),
    shard: safeToken(initialFilters.shard, 'all'),
  };
  let disclosure = { returnedBytes: 0, maxBytes: 0, truncated: false, sources: [], updatedAt: null };

  root.id ||= 'run-log-region';
  root.classList.add('run-log-region');
  root.dataset.asyncState = 'initial-loading';
  const controls = document.createElement('div');
  controls.className = 'run-log-controls';
  const search = document.createElement('input');
  search.id = 'run-log-search';
  search.type = 'search';
  search.placeholder = 'Search retained output';
  search.setAttribute('aria-label', 'Search retained output');
  const source = document.createElement('select');
  source.id = 'run-log-source-filter';
  source.setAttribute('aria-label', 'Filter logs by source');
  const stage = document.createElement('select');
  stage.id = 'run-log-stage-filter';
  stage.setAttribute('aria-label', 'Filter logs by stage');
  const shard = document.createElement('select');
  shard.id = 'run-log-shard-filter';
  shard.setAttribute('aria-label', 'Filter logs by shard');
  const pause = document.createElement('button');
  pause.id = 'run-log-pause';
  pause.type = 'button';
  pause.textContent = 'Pause tail';
  const jump = document.createElement('button');
  jump.id = 'run-log-jump';
  jump.type = 'button';
  jump.textContent = 'Jump to latest';
  const status = document.createElement('p');
  status.id = 'run-log-window-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = document.createElement('ol');
  list.id = 'run-log-list';
  list.className = 'run-log-list';
  list.tabIndex = 0;
  controls.append(search, source, stage, shard, pause, jump);
  root.replaceChildren(controls, status, list);

  function syncOptions(select, values, selected) {
    const choices = new Set([...values].filter((value) => value !== 'unknown'));
    if (selected !== 'all') choices.add(selected);
    select.replaceChildren(option(document, 'all'), ...[...choices].sort().map((value) => option(document, value)));
    select.value = selected;
  }

  function currentRecords() {
    return paused ? pausedRecords : buffer.snapshot.records;
  }

  function render() {
    const records = currentRecords();
    const retained = paused ? [...buffer.snapshot.records, ...pendingBuffer.snapshot.records] : buffer.snapshot.records;
    syncOptions(source, new Set(retained.map((record) => record.source)), filters.source);
    syncOptions(stage, new Set(retained.map((record) => record.stage)), filters.stage);
    syncOptions(shard, new Set(retained.map((record) => record.shard)), filters.shard);
    search.value = filters.search;
    const query = filters.search.trim().toLocaleLowerCase();
    const visible = records.filter((record) => (
      (filters.source === 'all' || record.source === filters.source)
      && (filters.stage === 'all' || record.stage === filters.stage)
      && (filters.shard === 'all' || record.shard === filters.shard)
      && (!query || `${record.timestamp ?? ''} ${record.source} ${record.stage} ${record.shard} ${record.message}`.toLocaleLowerCase().includes(query))
    ));
    const fragment = document.createDocumentFragment();
    for (const record of visible) {
      const item = document.createElement('li');
      item.dataset.logIdentity = record.identity;
      const metadata = document.createElement('span');
      metadata.className = 'run-log-metadata';
      metadata.textContent = [record.timestamp ?? 'time unknown', record.source, record.stage, record.shard !== 'unknown' ? record.shard : null].filter(Boolean).join(' · ');
      const message = document.createElement('code');
      message.textContent = record.message;
      item.append(metadata, message);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
    const snapshot = buffer.snapshot;
    const totalDropped = snapshot.dropped + pendingWindowDropped + pendingBuffer.snapshot.dropped;
    const truncation = disclosure.truncated || totalDropped > 0
      ? ` ${totalDropped} browser-window record${totalDropped === 1 ? '' : 's'} dropped; the server returned a bounded tail.`
      : '';
    const pendingRecords = pendingBuffer.snapshot.records.length;
    const pending = paused ? ` Paused with ${pendingRecords} newer record${pendingRecords === 1 ? '' : 's'} retained.` : '';
    status.textContent = `${visible.length} of ${records.length} retained records shown · ${snapshot.bytes.toLocaleString()} of ${snapshot.maxBytes.toLocaleString()} browser bytes.${truncation}${pending}`;
    root.dataset.asyncState = records.length ? (disclosure.truncated ? 'partial' : 'ready') : 'empty-success';
  }

  function replaceTail(text, metadata = {}) {
    buffer.replace(parseConsoleLogTail(text, { mode: auditMode }));
    disclosure = {
      returnedBytes: Number(metadata.bytes) || 0,
      maxBytes: Number(metadata.maxBytes) || 0,
      truncated: metadata.truncated === true,
      sources: Array.isArray(metadata.sources) ? metadata.sources.slice(0, 16) : [],
      updatedAt: new Date().toISOString(),
    };
    pendingBuffer.replace([]);
    pausedRecords = paused ? [...buffer.snapshot.records] : [];
    pendingWindowDropped = 0;
    render();
  }

  function append(input) {
    const sequence = Number.isSafeInteger(input?.sequence) ? input.sequence : null;
    if (sequence !== null && (buffer.hasSequence(sequence) || pendingBuffer.hasSequence(sequence))) return false;
    const accepted = paused ? pendingBuffer.append(input) : buffer.append(input);
    if (!accepted) return false;
    render();
    return true;
  }

  function togglePause() {
    paused = !paused;
    if (paused) {
      pausedRecords = [...buffer.snapshot.records];
      pendingBuffer.replace([]);
    } else {
      const pending = pendingBuffer.snapshot;
      pendingWindowDropped += pending.dropped;
      for (const record of pending.records) buffer.append(record);
      pendingBuffer.replace([]);
      pausedRecords = [];
    }
    pause.textContent = paused ? 'Resume tail' : 'Pause tail';
    pause.setAttribute('aria-pressed', String(paused));
    render();
    announce?.(paused ? 'Live output paused. New bounded records continue to be retained.' : 'Live output resumed.');
  }

  function jumpToLatest() {
    list.scrollTop = list.scrollHeight;
    list.focus({ preventScroll: true });
  }

  function readFilters() {
    filters = {
      search: boundedText(search.value.trim(), 300),
      source: safeToken(source.value, 'all'),
      stage: safeToken(stage.value, 'all'),
      shard: safeToken(shard.value, 'all'),
    };
  }

  function onFilterInput() {
    readFilters();
    render();
  }

  function onFilterCommit(event) {
    readFilters();
    onFiltersChange?.(Object.freeze({ ...filters }), event.currentTarget.id);
  }

  for (const control of [search, source, stage, shard]) {
    control.addEventListener('input', onFilterInput);
    control.addEventListener('change', onFilterCommit);
  }
  pause.addEventListener('click', togglePause);
  jump.addEventListener('click', jumpToLatest);
  render();
  return Object.freeze({
    replaceTail,
    append,
    setMode(nextMode) {
      if (!['comparative', 'single-site'].includes(nextMode)) throw new TypeError('Unknown log audit mode.');
      auditMode = nextMode;
    },
    setFilters(nextFilters = {}) {
      filters = {
        search: boundedText(nextFilters.search, 300),
        source: safeToken(nextFilters.source, 'all'),
        stage: safeToken(nextFilters.stage, 'all'),
        shard: safeToken(nextFilters.shard, 'all'),
      };
      render();
    },
    setState(state, message) {
      root.dataset.asyncState = state;
      if (message) status.textContent = message;
    },
    jumpToLatest,
    get snapshot() {
      const pending = pendingBuffer.snapshot;
      return Object.freeze({
        ...buffer.snapshot,
        paused,
        pendingRecords: pending.records.length,
        pendingBytes: pending.bytes,
        pendingDropped: pending.dropped,
        filters: Object.freeze({ ...filters }),
        disclosure: Object.freeze({ ...disclosure }),
      });
    },
    destroy() {
      for (const control of [search, source, stage, shard]) {
        control.removeEventListener('input', onFilterInput);
        control.removeEventListener('change', onFilterCommit);
      }
      pause.removeEventListener('click', togglePause);
      jump.removeEventListener('click', jumpToLatest);
      root.replaceChildren();
    },
  });
}
