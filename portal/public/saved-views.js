const DOCUMENT_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SENSITIVE_VALUE = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{4,})/i;
const ALLOWED_LAYOUT_KEYS = new Set(['inspectorWidth', 'navigationCollapsed']);

export function createSavedViewsStore({
  storageProvider = () => window.localStorage,
  storageKey = 'audit-console.saved-views.v1',
  parse,
  serialize,
  allowedRouteIds,
  maximumEntries = 12,
  maximumEntryBytes = 4_096,
  maximumAggregateBytes = 32_768,
}) {
  const routeIds = new Set(allowedRouteIds);
  let storage = null;
  let storageAvailable = true;
  let entries = [];
  try { storage = storageProvider(); } catch { storageAvailable = false; }

  function bytes(value) { return new TextEncoder().encode(value).byteLength; }

  function safeLayout(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Object.create(null);
    const output = Object.create(null);
    for (const key of Object.keys(input)) {
      if (!ALLOWED_LAYOUT_KEYS.has(key)) throw new TypeError('Saved view layout is invalid.');
      if (key === 'inspectorWidth') {
        if (!Number.isInteger(input[key]) || input[key] < 240 || input[key] > 560) throw new TypeError('Saved inspector width is invalid.');
        output[key] = input[key];
      } else if (typeof input[key] === 'boolean') output[key] = input[key];
      else throw new TypeError('Saved navigation preference is invalid.');
    }
    return output;
  }

  function safeParameters(routeId, input) {
    const search = serialize(routeId, input);
    const parsed = parse(routeId, search);
    if (!parsed.valid || parsed.rejected.length > 0) throw new TypeError('Saved view parameters are invalid.');
    const output = Object.create(null);
    for (const [key, value] of Object.entries(parsed.state)) output[key] = Array.isArray(value) ? [...value] : value;
    return output;
  }

  function validate(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Saved view record is invalid.');
    const allowed = new Set(['schemaVersion', 'id', 'name', 'routeId', 'parameters', 'layout', 'updatedAt']);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new TypeError('Saved view record has unknown fields.');
    if (record.schemaVersion !== DOCUMENT_VERSION || !ID_PATTERN.test(record.id) || !routeIds.has(record.routeId)) throw new TypeError('Saved view identity is invalid.');
    if (typeof record.name !== 'string' || record.name.trim() !== record.name || record.name.length < 1 || record.name.length > 80) throw new TypeError('Saved view name is invalid.');
    if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) throw new TypeError('Saved view timestamp is invalid.');
    const normalized = {
      schemaVersion: DOCUMENT_VERSION,
      id: record.id,
      name: record.name,
      routeId: record.routeId,
      parameters: safeParameters(record.routeId, record.parameters),
      layout: safeLayout(record.layout),
      updatedAt: record.updatedAt,
    };
    const encoded = JSON.stringify(normalized);
    if (SENSITIVE_VALUE.test(encoded) || bytes(encoded) > maximumEntryBytes) throw new TypeError('Saved view content is invalid.');
    return Object.freeze(normalized);
  }

  function read() {
    if (!storageAvailable || !storage) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      if (bytes(raw) > maximumAggregateBytes) throw new TypeError('Saved views exceed their storage limit.');
      const document = JSON.parse(raw);
      if (!document || document.schemaVersion !== DOCUMENT_VERSION || !Array.isArray(document.entries) || document.entries.length > maximumEntries) {
        throw new TypeError('Saved views document is invalid.');
      }
      entries = document.entries.flatMap((entry) => {
        try { return [validate(entry)]; } catch { return []; }
      });
    } catch {
      entries = [];
      try { storage.removeItem(storageKey); } catch { storageAvailable = false; }
    }
  }

  function persist(nextEntries) {
    const encoded = JSON.stringify({ schemaVersion: DOCUMENT_VERSION, entries: nextEntries });
    if (bytes(encoded) > maximumAggregateBytes) throw new TypeError('Saved views exceed their aggregate limit.');
    entries = nextEntries;
    if (storageAvailable && storage) {
      try { storage.setItem(storageKey, encoded); } catch { storageAvailable = false; }
    }
  }

  function save({ id, name, routeId, parameters, layout = {}, updatedAt = new Date().toISOString() }) {
    const entry = validate({ schemaVersion: DOCUMENT_VERSION, id, name, routeId, parameters, layout, updatedAt });
    const next = [entry, ...entries.filter((item) => item.id !== entry.id)].slice(0, maximumEntries);
    persist(next);
    return entry;
  }

  function remove(id) {
    persist(entries.filter((entry) => entry.id !== id));
  }

  read();
  return {
    list: () => entries.map((entry) => structuredClone(entry)),
    get: (id) => {
      const entry = entries.find((item) => item.id === id);
      return entry ? structuredClone(entry) : null;
    },
    save,
    remove,
    get storageAvailable() { return storageAvailable; },
  };
}
