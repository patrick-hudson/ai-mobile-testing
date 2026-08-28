const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/;
const ITEM_ID = /^gitem_[a-f0-9]{16}$/;
const COMPARATIVE_REVISION = /^(?:content|order|flags)_[a-f0-9]{16}$/;
const SINGLE_SITE_REVISION = /^[a-f0-9]{32}$/;

function requiredRunId(value) {
  if (typeof value !== 'string' || !RUN_ID.test(value)) throw new TypeError('A valid gallery run ID is required.');
  return value;
}

function requiredRequest(value) {
  if (typeof value !== 'function') throw new TypeError('A gallery request function is required.');
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return candidate;
}

function appendRevision(params, key, value, pattern) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${key} is invalid.`);
  params.set(key, value);
}

function appendOptionalInteger(params, key, value) {
  if (value === undefined || value === null) return;
  params.set(key, String(boundedInteger(value, 0, 0, Number.MAX_SAFE_INTEGER, key)));
}

function appendComparativeQuery(params, query = {}) {
  const names = {
    kinds: 'kind', statuses: 'status', environments: 'environment', featureSuites: 'featureSuite',
    technicalSuites: 'technicalSuite', targets: 'target', flagStates: 'flagState',
  };
  for (const [key, name] of Object.entries(names)) {
    for (const value of Array.isArray(query[key]) ? query[key].slice(0, 20) : []) {
      if (typeof value === 'string' && value.length > 0 && value.length <= 1_200) params.append(name, value);
    }
  }
  if (['feature', 'technical', 'none'].includes(query.group)) params.set('group', query.group);
  if (['attention', 'feature', 'technical', 'audit', 'capture-time'].includes(query.sort)) params.set('sort', query.sort);
  if (typeof query.search === 'string' && query.search.length > 0 && query.search.length <= 1_200) params.set('q', query.search);
}

function comparativeDataSource(runId, requestJson) {
  const run = encodeURIComponent(runId);
  const root = `/api/runs/${run}/gallery`;
  return Object.freeze({
    mode: 'comparative',
    endpoints: Object.freeze({ root }),
    loadHead({ signal } = {}) {
      return requestJson(root, { signal, activityPath: '/api/runs/:run/gallery' });
    },
    loadItems({ query, contentRevision, orderRevision, flagRevision, cursor, limit = 100, anchorItemId, signal } = {}) {
      const params = new URLSearchParams({ limit: String(boundedInteger(limit, 100, 1, 100, 'Gallery page limit')) });
      if (cursor) params.set('cursor', String(cursor));
      else if (anchorItemId) {
        if (!ITEM_ID.test(anchorItemId)) throw new TypeError('Gallery anchor item ID is invalid.');
        params.set('anchor', anchorItemId);
      }
      appendRevision(params, 'contentRevision', contentRevision, COMPARATIVE_REVISION);
      appendRevision(params, 'orderRevision', orderRevision, COMPARATIVE_REVISION);
      appendRevision(params, 'flagRevision', flagRevision, COMPARATIVE_REVISION);
      appendComparativeQuery(params, query);
      return requestJson(`${root}/items?${params}`, {
        signal, activityPath: '/api/runs/:run/gallery/items', rowCount: (value) => value?.items?.length,
      });
    },
    loadItem({ itemId, contentRevision, orderRevision, flagRevision, signal } = {}) {
      if (!ITEM_ID.test(itemId ?? '')) throw new TypeError('Gallery item ID is invalid.');
      const params = new URLSearchParams();
      appendRevision(params, 'contentRevision', contentRevision, COMPARATIVE_REVISION);
      appendRevision(params, 'orderRevision', orderRevision, COMPARATIVE_REVISION);
      appendRevision(params, 'flagRevision', flagRevision, COMPARATIVE_REVISION);
      return requestJson(`${root}/items/${encodeURIComponent(itemId)}?${params}`, {
        signal, activityPath: '/api/runs/:run/gallery/items/:item',
      });
    },
  });
}

function singleSiteEndpoints(runId) {
  const run = encodeURIComponent(requiredRunId(runId));
  const gallery = `/api/single-site/runs/${run}/gallery`;
  return Object.freeze({
    gallery,
    head: () => gallery,
    items: (query = '') => `${gallery}/items${query ? `?${String(query).replace(/^\?/, '')}` : ''}`,
    item: (itemId, query = '') => `${gallery}/items/${encodeURIComponent(String(itemId))}${query ? `?${String(query).replace(/^\?/, '')}` : ''}`,
    review: (itemId) => `${gallery}/items/${encodeURIComponent(String(itemId))}/review`,
    currentMedia: (itemId) => `${gallery}/items/${encodeURIComponent(String(itemId))}/media/current`,
    diffMedia: (itemId) => `${gallery}/items/${encodeURIComponent(String(itemId))}/media/diff`,
    baselineCollection: (query = '') => `/api/single-site/visual-baselines${query ? `?${String(query).replace(/^\?/, '')}` : ''}`,
    baseline: (baselineId) => `/api/single-site/visual-baselines/${encodeURIComponent(String(baselineId))}`,
    baselineMedia: (baselineId) => `/api/single-site/visual-baselines/${encodeURIComponent(String(baselineId))}/media`,
    approve: () => '/api/single-site/visual-baselines/approve',
    replace: (baselineId) => `/api/single-site/visual-baselines/${encodeURIComponent(String(baselineId))}/replace`,
    revoke: (baselineId) => `/api/single-site/visual-baselines/${encodeURIComponent(String(baselineId))}/revoke`,
    delete: (baselineId) => `/api/single-site/visual-baselines/${encodeURIComponent(String(baselineId))}`,
  });
}

function singleSiteDataSource(runId, requestJson) {
  const endpoints = singleSiteEndpoints(runId);
  return Object.freeze({
    mode: 'single-site',
    endpoints,
    loadHead({ signal } = {}) {
      return requestJson(endpoints.head(), { signal, activityPath: '/api/single-site/runs/:run/gallery' });
    },
    loadItems({ filters = {}, offset = 0, limit = 50, anchorItemId = null, publicationRevision, baselineStoreRevision, reviewRevision, signal } = {}) {
      const params = new URLSearchParams({
        offset: String(boundedInteger(offset, 0, 0, 10_000, 'Gallery page offset')),
        limit: String(boundedInteger(limit, 50, 1, 100, 'Gallery page limit')),
      });
      appendRevision(params, 'revision', publicationRevision, SINGLE_SITE_REVISION);
      appendOptionalInteger(params, 'baselineStoreRevision', baselineStoreRevision);
      appendOptionalInteger(params, 'reviewRevision', reviewRevision);
      for (const key of ['scope', 'kind', 'suite', 'finding', 'coverage', 'visual']) {
        const value = filters[key];
        if (typeof value === 'string' && value.length > 0 && value.length <= 1_200) params.set(key, value);
      }
      if (typeof filters.query === 'string' && filters.query.length > 0 && filters.query.length <= 1_200) params.set('q', filters.query);
      if (anchorItemId) {
        if (!ITEM_ID.test(anchorItemId)) throw new TypeError('Gallery anchor item ID is invalid.');
        params.set('anchor', anchorItemId);
      }
      return requestJson(endpoints.items(params), {
        signal, activityPath: '/api/single-site/runs/:run/gallery/items', rowCount: (value) => value?.items?.length,
      });
    },
    loadItem({ itemId, publicationRevision, baselineStoreRevision, reviewRevision, signal } = {}) {
      if (!ITEM_ID.test(itemId ?? '')) throw new TypeError('Gallery item ID is invalid.');
      const params = new URLSearchParams();
      appendRevision(params, 'revision', publicationRevision, SINGLE_SITE_REVISION);
      appendOptionalInteger(params, 'baselineStoreRevision', baselineStoreRevision);
      appendOptionalInteger(params, 'reviewRevision', reviewRevision);
      return requestJson(endpoints.item(itemId, params), {
        signal, activityPath: '/api/single-site/runs/:run/gallery/items/:item',
      });
    },
  });
}

export function createLiveGalleryDataSource({ mode, runId, requestJson }) {
  const safeRunId = requiredRunId(runId);
  const request = requiredRequest(requestJson);
  if (mode === 'comparative') return comparativeDataSource(safeRunId, request);
  if (mode === 'single-site') return singleSiteDataSource(safeRunId, request);
  throw new TypeError('Gallery data-source mode must be comparative or single-site.');
}

export { singleSiteEndpoints };
