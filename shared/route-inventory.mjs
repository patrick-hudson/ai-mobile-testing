import { isIP } from 'node:net';

export const ROUTE_INVENTORY_SCHEMA_VERSION = 1;

export const DEFAULT_ROUTE_INVENTORY_LIMITS = Object.freeze({
  maxRoutes: 500,
  maxDepth: 4,
  maxConcurrency: 8,
  maxHtmlBytes: 50 * 1024 * 1024,
  maxDurationMs: 60_000,
  maxQueryVariantsPerPath: 3,
  maxQueryParameters: 12,
});

const SOURCE_ORDER = Object.freeze([
  'catalog',
  'deployment-manifest',
  'sitemap',
  'rendered-navigation',
]);
const SOURCE_RANK = new Map([...SOURCE_ORDER, 'crawl'].map((source, index) => [source, index]));
const DOWNLOAD_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.csv', '.dmg', '.doc', '.docx', '.epub', '.exe', '.gz',
  '.iso', '.mov', '.mp3', '.mp4', '.msi', '.pdf', '.ppt', '.pptx', '.rar', '.tar',
  '.tgz', '.wav', '.webm', '.xls', '.xlsx', '.xml', '.zip',
]);
const ASSET_EXTENSIONS = new Set([
  '.avif', '.bmp', '.css', '.gif', '.ico', '.jpeg', '.jpg', '.js', '.json', '.map',
  '.mjs', '.otf', '.png', '.svg', '.ttf', '.webp', '.woff', '.woff2',
]);
const EXCLUSION_CODES = new Set([
  'invalid-url', 'non-http', 'credentialed-url', 'loopback-address', 'private-address',
  'link-local-address', 'metadata-address', 'cross-origin', 'form-submit', 'api-path',
  'logout-path', 'download', 'asset', 'query-parameter-limit', 'query-variant-limit',
  'route-limit', 'depth-limit', 'non-html-response', 'html-byte-limit', 'url-policy-rejected',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedLimits(overrides = {}) {
  const limits = { ...DEFAULT_ROUTE_INVENTORY_LIMITS, ...(isRecord(overrides) ? overrides : {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Route inventory limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function normalizeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Route inventory origin must be a valid HTTP(S) origin.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('Route inventory origin must be an HTTP(S) origin without credentials, path, query, or fragment.');
  }
  if (privateAddressReason(parsed.hostname)) {
    throw new TypeError('Route inventory origin must not use a loopback, private, link-local, or metadata address.');
  }
  return parsed.origin;
}

function normalizeCandidateInput(value) {
  if (typeof value === 'string') return { url: value };
  if (!isRecord(value) || typeof value.url !== 'string') {
    throw new TypeError('Route candidates must be URL strings or objects with a string url.');
  }
  return {
    url: value.url,
    from: typeof value.from === 'string' ? value.from : null,
    method: typeof value.method === 'string' ? value.method.toUpperCase() : 'GET',
    discoveryKind: value.discoveryKind === 'form' ? 'form' : 'link',
    download: value.download === true,
    rel: typeof value.rel === 'string' ? value.rel : '',
  };
}

function normalizedPathname(pathname) {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.endsWith('/') ? collapsed.slice(0, -1) || '/' : collapsed;
}

function normalizedSearch(searchParams) {
  const pairs = [...searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => (
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  ));
  const normalized = new URLSearchParams();
  for (const [key, value] of pairs) normalized.append(key, value);
  const serialized = normalized.toString();
  return serialized ? `?${serialized}` : '';
}

function extensionFor(pathname) {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot <= 0 ? '' : last.slice(dot).toLowerCase();
}

function privateAddressReason(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return 'loopback-address';
  const family = isIP(normalized);
  if (family === 4) {
    const octets = normalized.split('.').map(Number);
    const [first, second] = octets;
    if (first === 127 || first === 0) return 'loopback-address';
    if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return 'private-address';
    if (first === 169 && second === 254) return normalized === '169.254.169.254' ? 'metadata-address' : 'link-local-address';
    if ((first === 100 && second >= 64 && second <= 127) || (first === 198 && second >= 18 && second <= 19)) return 'private-address';
    if (first >= 224) return 'private-address';
  }
  if (family === 6) {
    if (normalized === '::1' || normalized === '::') return 'loopback-address';
    if (normalized.startsWith('::ffff:') || normalized.startsWith('ff')) return 'private-address';
    if (/^fe[89ab]/i.test(normalized)) return 'link-local-address';
    if (/^f[cd]/i.test(normalized)) return 'private-address';
  }
  return null;
}

function exclusion(code, candidate, source, detail, depth) {
  return {
    code,
    source,
    url: candidate.url,
    from: candidate.from ?? null,
    depth,
    detail,
  };
}

async function assessCandidate(rawCandidate, context) {
  let candidate;
  try {
    candidate = normalizeCandidateInput(rawCandidate);
  } catch (error) {
    return { exclusion: exclusion('invalid-url', { url: String(rawCandidate), from: null }, context.source, error.message, context.depth) };
  }
  let parsed;
  try {
    parsed = new URL(candidate.url, context.origin);
  } catch {
    return { exclusion: exclusion('invalid-url', candidate, context.source, 'URL parsing failed.', context.depth) };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { exclusion: exclusion('non-http', candidate, context.source, `Protocol ${parsed.protocol || '(missing)'} is not crawlable.`, context.depth) };
  }
  if (parsed.username || parsed.password) {
    return { exclusion: exclusion('credentialed-url', candidate, context.source, 'Credentialed URLs are forbidden.', context.depth) };
  }
  const addressReason = privateAddressReason(parsed.hostname);
  if (addressReason) {
    return { exclusion: exclusion(addressReason, candidate, context.source, 'Loopback, private, link-local, and metadata destinations are forbidden.', context.depth) };
  }
  if (parsed.origin !== context.origin) {
    return { exclusion: exclusion('cross-origin', candidate, context.source, `Expected exact origin ${context.origin}.`, context.depth) };
  }
  if (candidate.discoveryKind === 'form' || !['GET', 'HEAD'].includes(candidate.method)) {
    return { exclusion: exclusion('form-submit', candidate, context.source, `Form or ${candidate.method} submission is not crawlable.`, context.depth) };
  }
  const pathname = normalizedPathname(parsed.pathname);
  if (/(?:^|\/)(?:api|graphql)(?:\/|$)/i.test(pathname)) {
    return { exclusion: exclusion('api-path', candidate, context.source, 'API paths are excluded from HTML route discovery.', context.depth) };
  }
  if (/(?:^|\/)(?:log[-_]?out|sign[-_]?out)(?:\/|$)/i.test(pathname)) {
    return { exclusion: exclusion('logout-path', candidate, context.source, 'Logout and sign-out paths are forbidden.', context.depth) };
  }
  const extension = extensionFor(pathname);
  if (candidate.download || /(?:^|\s)download(?:\s|$)/i.test(candidate.rel) || DOWNLOAD_EXTENSIONS.has(extension)) {
    return { exclusion: exclusion('download', candidate, context.source, 'Download destinations are not HTML routes.', context.depth) };
  }
  if (ASSET_EXTENSIONS.has(extension)) {
    return { exclusion: exclusion('asset', candidate, context.source, 'Static asset destinations are not HTML routes.', context.depth) };
  }
  if ([...parsed.searchParams.keys()].length > context.limits.maxQueryParameters) {
    return { exclusion: exclusion('query-parameter-limit', candidate, context.source, `More than ${context.limits.maxQueryParameters} query parameters were supplied.`, context.depth) };
  }
  parsed.hash = '';
  parsed.pathname = pathname;
  parsed.search = normalizedSearch(parsed.searchParams);
  const canonicalUrl = pathname === '/'
    ? `${parsed.origin}${parsed.search}`
    : `${parsed.origin}${pathname}${parsed.search}`;

  if (context.urlPolicy) {
    let verdict;
    try {
      verdict = await context.urlPolicy({ url: canonicalUrl, origin: context.origin, source: context.source, depth: context.depth });
    } catch (error) {
      return { policyFailure: { code: 'url-policy-error', source: context.source, url: canonicalUrl, detail: error instanceof Error ? error.message : String(error) } };
    }
    if (!verdict || verdict.allowed !== true) {
      const code = EXCLUSION_CODES.has(verdict?.code) ? verdict.code : 'url-policy-rejected';
      const detail = typeof verdict?.detail === 'string' && verdict.detail ? verdict.detail : 'Injected URL policy rejected this destination.';
      return { exclusion: exclusion(code, { ...candidate, url: canonicalUrl }, context.source, detail, context.depth) };
    }
  }

  return {
    candidate,
    normalized: {
      url: canonicalUrl,
      path: pathname,
      query: parsed.search,
    },
  };
}

function stableContribution(contribution) {
  return `${String(SOURCE_RANK.get(contribution.source) ?? 99).padStart(2, '0')}\0${contribution.source}\0${contribution.from ?? ''}\0${String(contribution.depth).padStart(6, '0')}`;
}

function uniqueSorted(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()].sort((left, right) => key(left).localeCompare(key(right)));
}

function routeRecord(normalized) {
  return {
    url: normalized.url,
    path: normalized.path,
    query: normalized.query,
    disposition: 'included',
    sources: [],
  };
}

function addContribution(route, contribution) {
  const key = stableContribution(contribution);
  if (!route.sources.some((entry) => stableContribution(entry) === key)) route.sources.push(contribution);
  route.sources.sort((left, right) => stableContribution(left).localeCompare(stableContribution(right)));
}

async function loadAdapter(adapter, source, origin) {
  if (adapter === undefined || adapter === null) return { candidates: [], limitations: [] };
  const loaded = typeof adapter === 'function' ? await adapter({ origin, source }) : adapter;
  if (Array.isArray(loaded)) return { candidates: loaded, limitations: [] };
  if (!isRecord(loaded) || !Array.isArray(loaded.candidates)) {
    throw new TypeError(`${source} adapter must return an array or { candidates, limitations }.`);
  }
  const limitations = Array.isArray(loaded.limitations) ? loaded.limitations.map((item) => ({
    code: ['source-unavailable', 'source-partial', 'route-type-unenumerable'].includes(item?.code) ? item.code : 'source-partial',
    source,
    detail: typeof item?.detail === 'string' && item.detail ? item.detail : 'Adapter reported an unspecified limitation.',
  })) : [];
  return { candidates: loaded.candidates, limitations };
}

function responseBytes(result) {
  if (Number.isSafeInteger(result?.bodyBytes) && result.bodyBytes >= 0) return result.bodyBytes;
  if (typeof result?.body === 'string') return Buffer.byteLength(result.body);
  if (result?.body instanceof Uint8Array) return result.body.byteLength;
  return 0;
}

function contentTypeFor(result) {
  return typeof result?.contentType === 'string' ? result.contentType.split(';', 1)[0].trim().toLowerCase() : '';
}

function timeoutPromise(milliseconds, controller) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Route fetch exceeded the inventory duration bound.'), { code: 'ROUTE_INVENTORY_TIMEOUT' }));
    }, Math.max(1, milliseconds));
    timer.unref?.();
  });
  return { promise, clear: () => clearTimeout(timer) };
}

async function fetchWithinDeadline(fetchPage, request, remainingMs) {
  const controller = new AbortController();
  const timeout = timeoutPromise(remainingMs, controller);
  try {
    return await Promise.race([fetchPage({ ...request, signal: controller.signal }), timeout.promise]);
  } finally {
    timeout.clear();
  }
}

export async function buildRouteInventory(options) {
  if (!isRecord(options)) throw new TypeError('Route inventory options must be an object.');
  const origin = normalizeOrigin(options.origin);
  const limits = normalizedLimits(options.limits);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new TypeError('Route inventory clock must return a finite number.');
  const fetchPage = typeof options.fetchPage === 'function' ? options.fetchPage : null;
  const urlPolicy = typeof options.urlPolicy === 'function' ? options.urlPolicy : null;
  if (fetchPage && !urlPolicy) {
    throw new TypeError('Route inventory fetchPage requires an injected outbound URL policy for every route and redirect hop.');
  }
  const adapters = isRecord(options.adapters) ? options.adapters : {};
  const routes = new Map();
  const queryVariants = new Map();
  const observedQueryVariants = new Map();
  const sourceCandidateCounts = new Map([...SOURCE_ORDER, 'crawl'].map((source) => [source, 0]));
  const exclusions = [];
  const failures = [];
  const limitations = [];
  const responses = [];
  const redirects = [];
  const exhausted = new Set();
  let observedDepth = 0;
  let htmlBytes = 0;
  let htmlBytesObserved = 0;
  let peakConcurrency = 0;
  let durationExceeded = false;

  const add = async (rawCandidate, source, depth, from = null) => {
    sourceCandidateCounts.set(source, (sourceCandidateCounts.get(source) ?? 0) + 1);
    observedDepth = Math.max(observedDepth, depth);
    const enriched = typeof rawCandidate === 'string'
      ? { url: rawCandidate, from }
      : { ...rawCandidate, from: rawCandidate?.from ?? from };
    const assessed = await assessCandidate(enriched, { origin, source, depth, limits, urlPolicy });
    if (assessed.exclusion) {
      exclusions.push(assessed.exclusion);
      return null;
    }
    if (assessed.policyFailure) {
      failures.push(assessed.policyFailure);
      return null;
    }
    const { normalized } = assessed;
    const existing = routes.get(normalized.url);
    const contribution = { source, from: enriched.from ?? null, depth };
    if (existing) {
      addContribution(existing, contribution);
      return existing;
    }
    if (normalized.query) {
      const observedVariants = observedQueryVariants.get(normalized.path) ?? new Set();
      observedVariants.add(normalized.query);
      observedQueryVariants.set(normalized.path, observedVariants);
      const variants = queryVariants.get(normalized.path) ?? new Set();
      if (!variants.has(normalized.query) && variants.size >= limits.maxQueryVariantsPerPath) {
        exhausted.add('query-variants');
        exclusions.push(exclusion('query-variant-limit', enriched, source, `Only ${limits.maxQueryVariantsPerPath} query variants are retained per path.`, depth));
        return null;
      }
      variants.add(normalized.query);
      queryVariants.set(normalized.path, variants);
    }
    if (routes.size >= limits.maxRoutes) {
      exhausted.add('route-count');
      exclusions.push(exclusion('route-limit', enriched, source, `The ${limits.maxRoutes}-route ceiling was reached.`, depth));
      return null;
    }
    const route = routeRecord(normalized);
    addContribution(route, contribution);
    routes.set(normalized.url, route);
    return route;
  };

  for (const source of SOURCE_ORDER) {
    let loaded;
    try {
      loaded = await loadAdapter(adapters[source], source, origin);
    } catch (error) {
      failures.push({ code: 'adapter-error', source, url: null, detail: error instanceof Error ? error.message : String(error) });
      limitations.push({ code: 'source-unavailable', source, detail: `${source} adapter could not be loaded.` });
      continue;
    }
    limitations.push(...loaded.limitations);
    const candidates = [...loaded.candidates].sort((left, right) => {
      const leftUrl = typeof left === 'string' ? left : String(left?.url ?? '');
      const rightUrl = typeof right === 'string' ? right : String(right?.url ?? '');
      return leftUrl.localeCompare(rightUrl);
    });
    for (const candidate of candidates) await add(candidate, source, 0);
  }

  const entryPoints = options.entryPoints === undefined ? ['/'] : options.entryPoints;
  if (!Array.isArray(entryPoints)) throw new TypeError('entryPoints must be an array.');
  let frontier = [...routes.keys()];
  for (const entryPoint of [...entryPoints].sort((left, right) => String(left).localeCompare(String(right)))) {
    const route = await add(entryPoint, 'crawl', 0);
    if (route) frontier.push(route.url);
  }
  frontier = [...new Set(frontier)].sort();

  if (!fetchPage && frontier.length > 0) {
    limitations.push({ code: 'crawl-unavailable', source: 'crawl', detail: 'No injected fetchPage adapter was provided.' });
    frontier = [];
  }

  const fetched = new Set();
  for (let depth = 0; frontier.length > 0; depth += 1) {
    observedDepth = Math.max(observedDepth, depth);
    if (depth > limits.maxDepth) {
      exhausted.add('crawl-depth');
      for (const url of frontier) exclusions.push(exclusion('depth-limit', { url, from: null }, 'crawl', `The crawl depth ceiling of ${limits.maxDepth} was reached.`, depth));
      break;
    }
    const pending = frontier.filter((url) => !fetched.has(url)).sort();
    frontier = [];
    for (let offset = 0; offset < pending.length; offset += limits.maxConcurrency) {
      const elapsed = Math.max(0, now() - startedAt);
      if (elapsed >= limits.maxDurationMs) {
        durationExceeded = true;
        exhausted.add('duration');
        break;
      }
      const batch = pending.slice(offset, offset + limits.maxConcurrency);
      peakConcurrency = Math.max(peakConcurrency, batch.length);
      for (const url of batch) fetched.add(url);
      const remainingMs = limits.maxDurationMs - elapsed;
      const results = await Promise.all(batch.map(async (url) => {
        try {
          const result = await fetchWithinDeadline(fetchPage, { url, depth, origin }, remainingMs);
          return { url, result };
        } catch (error) {
          return { url, error };
        }
      }));
      for (const outcome of results.sort((left, right) => left.url.localeCompare(right.url))) {
        const route = routes.get(outcome.url);
        if (outcome.error) {
          const timedOut = outcome.error?.code === 'ROUTE_INVENTORY_TIMEOUT';
          failures.push({
            code: timedOut ? 'fetch-timeout' : 'fetch-error',
            source: 'crawl',
            url: outcome.url,
            detail: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
          });
          if (route) route.disposition = 'fetch-failed';
          if (timedOut) {
            durationExceeded = true;
            exhausted.add('duration');
          }
          continue;
        }
        if (!isRecord(outcome.result) || !Number.isInteger(outcome.result.status)) {
          failures.push({ code: 'invalid-response', source: 'crawl', url: outcome.url, detail: 'fetchPage must return an integer HTTP status.' });
          if (route) route.disposition = 'fetch-failed';
          continue;
        }
        const bytes = responseBytes(outcome.result);
        const contentType = contentTypeFor(outcome.result);
        htmlBytesObserved += bytes;
        responses.push({
          url: outcome.url,
          depth,
          status: outcome.result.status,
          contentType: contentType || null,
          bytes,
        });
        if (outcome.result.status >= 400) {
          failures.push({ code: 'http-status', source: 'crawl', url: outcome.url, detail: `HTTP ${outcome.result.status}.` });
          if (route) route.disposition = 'unreachable';
        }
        if (typeof outcome.result.redirectUrl === 'string') {
          const redirectAssessment = await assessCandidate({ url: outcome.result.redirectUrl, from: outcome.url }, {
            origin, source: 'crawl', depth, limits, urlPolicy,
          });
          redirects.push({
            from: outcome.url,
            to: redirectAssessment.normalized?.url ?? outcome.result.redirectUrl,
            status: outcome.result.status,
            accepted: Boolean(redirectAssessment.normalized),
          });
          const redirected = await add({ url: outcome.result.redirectUrl, from: outcome.url }, 'crawl', depth);
          if (redirected && !fetched.has(redirected.url)) frontier.push(redirected.url);
        }
        if (!contentType.startsWith('text/html')) {
          if (route) route.disposition = 'non-html';
          exclusions.push(exclusion('non-html-response', { url: outcome.url, from: null }, 'crawl', `Response content type ${contentType || '(missing)'} is not HTML.`, depth));
          continue;
        }
        if (htmlBytes + bytes > limits.maxHtmlBytes) {
          exhausted.add('html-bytes');
          exclusions.push(exclusion('html-byte-limit', { url: outcome.url, from: null }, 'crawl', `The ${limits.maxHtmlBytes}-byte HTML ceiling was reached.`, depth));
          continue;
        }
        htmlBytes += bytes;
        if (depth >= limits.maxDepth) {
          const remainingCandidates = [
            ...(Array.isArray(outcome.result.links) ? outcome.result.links : []),
            ...(Array.isArray(outcome.result.forms) ? outcome.result.forms.map((form) => ({ ...form, discoveryKind: 'form' })) : []),
          ];
          if (remainingCandidates.length > 0) {
            exhausted.add('crawl-depth');
            for (const candidate of remainingCandidates) {
              let normalizedCandidate;
              try {
                normalizedCandidate = normalizeCandidateInput(candidate);
              } catch {
                normalizedCandidate = { url: String(candidate), from: outcome.url };
              }
              if (!normalizedCandidate.from) normalizedCandidate.from = outcome.url;
              exclusions.push(exclusion('depth-limit', normalizedCandidate, 'crawl', `The crawl depth ceiling of ${limits.maxDepth} was reached.`, depth + 1));
            }
          }
          continue;
        }
        const discovered = [
          ...(Array.isArray(outcome.result.links) ? outcome.result.links : []),
          ...(Array.isArray(outcome.result.forms) ? outcome.result.forms.map((form) => ({ ...form, discoveryKind: 'form' })) : []),
        ].sort((left, right) => {
          const leftUrl = typeof left === 'string' ? left : String(left?.url ?? '');
          const rightUrl = typeof right === 'string' ? right : String(right?.url ?? '');
          return leftUrl.localeCompare(rightUrl);
        });
        for (const candidate of discovered) {
          const child = await add(candidate, 'crawl', depth + 1, outcome.url);
          if (child && !fetched.has(child.url)) frontier.push(child.url);
        }
      }
      if (durationExceeded || exhausted.has('html-bytes')) break;
    }
    if (durationExceeded || exhausted.has('html-bytes')) break;
    frontier = [...new Set(frontier)].sort();
  }

  const durationMs = Math.max(0, now() - startedAt);
  if (durationMs >= limits.maxDurationMs) {
    durationExceeded = true;
    exhausted.add('duration');
  }
  const maxObservedQueryVariants = Math.max(0, ...[...observedQueryVariants.values()].map((variants) => variants.size));
  const bounds = [
    { code: 'route-count', limit: limits.maxRoutes, observed: routes.size, exhausted: exhausted.has('route-count') },
    { code: 'crawl-depth', limit: limits.maxDepth, observed: observedDepth, exhausted: exhausted.has('crawl-depth') },
    { code: 'concurrency', limit: limits.maxConcurrency, observed: peakConcurrency, exhausted: false },
    { code: 'html-bytes', limit: limits.maxHtmlBytes, observed: htmlBytesObserved, exhausted: exhausted.has('html-bytes') },
    { code: 'duration', limit: limits.maxDurationMs, observed: durationMs, exhausted: durationExceeded },
    { code: 'query-variants', limit: limits.maxQueryVariantsPerPath, observed: maxObservedQueryVariants, exhausted: exhausted.has('query-variants') },
  ];

  const sortedRoutes = [...routes.values()]
    .map((route) => ({ ...route, sources: [...route.sources] }))
    .sort((left, right) => left.url.localeCompare(right.url));
  const sortedExclusions = uniqueSorted(exclusions, (item) => `${item.code}\0${item.source}\0${item.url}\0${item.from ?? ''}\0${item.depth}`);
  const sortedFailures = uniqueSorted(failures, (item) => `${item.code}\0${item.source}\0${item.url ?? ''}\0${item.detail}`);
  const sortedLimitations = uniqueSorted(limitations, (item) => `${item.code}\0${item.source}\0${item.detail}`);
  const sortedResponses = uniqueSorted(responses, (item) => `${item.url}\0${item.depth}\0${item.status}\0${item.contentType ?? ''}\0${item.bytes}`);
  const sortedRedirects = uniqueSorted(redirects, (item) => `${item.from}\0${item.to}\0${item.status}\0${item.accepted}`);
  const sourceSummaries = [...SOURCE_ORDER, 'crawl'].map((source) => ({
    source,
    candidatesObserved: sourceCandidateCounts.get(source) ?? 0,
    includedContributions: sortedRoutes.reduce(
      (total, route) => total + route.sources.filter((entry) => entry.source === source).length,
      0,
    ),
    exclusions: sortedExclusions.filter((entry) => entry.source === source).length,
    failures: sortedFailures.filter((entry) => entry.source === source).length,
    limitations: sortedLimitations.filter((entry) => entry.source === source).length,
  }));

  return {
    schemaVersion: ROUTE_INVENTORY_SCHEMA_VERSION,
    origin,
    limits: { ...limits },
    sources: sourceSummaries,
    routes: sortedRoutes,
    exclusions: sortedExclusions,
    failures: sortedFailures,
    limitations: sortedLimitations,
    responses: sortedResponses,
    redirects: sortedRedirects,
    bounds,
    summary: {
      routes: sortedRoutes.length,
      exclusions: sortedExclusions.length,
      failures: sortedFailures.length,
      limitations: sortedLimitations.length,
      responses: sortedResponses.length,
      redirects: sortedRedirects.length,
      htmlBytesConsumed: htmlBytes,
    },
  };
}
