import {
  OutboundUrlPolicyError,
  createOriginBoundFetcher,
  normalizeExactHttpOrigin,
} from './outbound-url-policy.mjs';
import { buildRouteInventory } from './route-inventory.mjs';

export const LIVE_ROUTE_INVENTORY_SCHEMA_VERSION = 1;

export const DEFAULT_LIVE_ROUTE_INVENTORY_LIMITS = Object.freeze({
  maxSitemaps: 24,
  maxSitemapDepth: 4,
  maxSitemapBytes: 10 * 1024 * 1024,
});

const XML_CONTENT_TYPES = new Set([
  'application/rss+xml',
  'application/xml',
  'application/xhtml+xml',
  'text/plain',
  'text/xml',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLimits(overrides) {
  const limits = {
    ...DEFAULT_LIVE_ROUTE_INVENTORY_LIMITS,
    ...(isRecord(overrides) ? overrides : {}),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Live route inventory limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function decodeEntities(value) {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|apos|gt|lt|quot);/gi, (entity, decimal, hexadecimal) => {
    if (decimal) {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    if (hexadecimal) {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return ({
      '&amp;': '&',
      '&apos;': "'",
      '&gt;': '>',
      '&lt;': '<',
      '&quot;': '"',
    })[entity.toLowerCase()] ?? entity;
  });
}

function parseAttributes(fragment) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of fragment.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || attributes.has(name)) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
}

function stripHtmlRawText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
}

function stableCandidateKey(candidate) {
  return [
    candidate.url,
    candidate.discoveryKind ?? 'link',
    candidate.method ?? 'GET',
    candidate.download === true ? '1' : '0',
    candidate.rel ?? '',
  ].join('\0');
}

function uniqueSorted(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()]
    .sort((left, right) => key(left).localeCompare(key(right)));
}

/**
 * Extracts only inert anchor and form metadata. It deliberately does not run
 * scripts, build a DOM, submit forms, or claim to represent rendered UI.
 */
export function parseInertHtmlNavigation(html, documentUrl) {
  if (typeof html !== 'string') throw new TypeError('HTML navigation input must be a string.');
  let baseUrl;
  try {
    baseUrl = new URL(documentUrl).href;
  } catch {
    throw new TypeError('HTML navigation documentUrl must be a valid absolute URL.');
  }
  const inert = stripHtmlRawText(html);
  let resolutionBase = baseUrl;
  const baseTag = /<base\b([^>]*)>/i.exec(inert);
  if (baseTag) {
    const declaredBase = parseAttributes(baseTag[1] ?? '').get('href');
    if (declaredBase) {
      try {
        resolutionBase = new URL(declaredBase, baseUrl).href;
      } catch {
        // An invalid base is ignored, matching the safe fallback to the
        // document URL without turning parsing into a network operation.
      }
    }
  }
  const resolveCandidate = (value) => {
    try {
      return new URL(value, resolutionBase).href;
    } catch {
      return value;
    }
  };
  const candidates = [];
  const tagPattern = /<(a|form)\b([^>]*)>/gi;
  for (const match of inert.matchAll(tagPattern)) {
    const tag = match[1].toLowerCase();
    const attributes = parseAttributes(match[2] ?? '');
    if (tag === 'a') {
      if (!attributes.has('href')) continue;
      const href = attributes.get('href');
      if (!href) continue;
      candidates.push({
        url: resolveCandidate(href),
        from: baseUrl,
        method: 'GET',
        discoveryKind: 'link',
        download: attributes.has('download'),
        rel: attributes.get('rel') ?? '',
      });
      continue;
    }
    candidates.push({
      url: resolveCandidate(attributes.get('action') || baseUrl),
      from: baseUrl,
      method: (attributes.get('method') || 'GET').toUpperCase(),
      discoveryKind: 'form',
    });
  }
  return uniqueSorted(candidates, stableCandidateKey);
}

function contentType(response) {
  return (response.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
}

function outboundFailure(error) {
  return {
    code: error instanceof OutboundUrlPolicyError ? error.code : 'OUTBOUND_REQUEST_FAILED',
    detail: error instanceof Error ? error.message : String(error),
  };
}

function canonicalSameOriginUrl(value, baseUrl, origin) {
  let parsed;
  try {
    parsed = new URL(value, baseUrl);
  } catch {
    return { accepted: false, code: 'invalid-url', detail: 'The discovered URL could not be parsed.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { accepted: false, code: 'non-http', detail: `Protocol ${parsed.protocol || '(missing)'} is not supported.` };
  }
  if (parsed.username || parsed.password) {
    return { accepted: false, code: 'credentialed-url', detail: 'Credentialed URLs are forbidden.' };
  }
  if (parsed.origin !== origin) {
    return { accepted: false, code: 'cross-origin', detail: `Expected exact origin ${origin}.` };
  }
  parsed.hash = '';
  return { accepted: true, url: parsed.href };
}

function extractRobotsSitemaps(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S.*?)\s*$/i.exec(line);
    if (match?.[1]) values.push(match[1]);
  }
  return [...new Set(values)].sort();
}

function sitemapShape(xml) {
  const withoutPreamble = xml
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const match = /^<(?:[\w.-]+:)?(sitemapindex|urlset)\b/i.exec(withoutPreamble);
  return match?.[1]?.toLowerCase() === 'sitemapindex'
    ? 'sitemap-index'
    : match?.[1]?.toLowerCase() === 'urlset'
      ? 'url-set'
      : 'unknown';
}

function extractSitemapLocations(xml) {
  const locations = [];
  const pattern = /<(?:[\w.-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?loc\s*>/gi;
  for (const match of xml.matchAll(pattern)) {
    const value = decodeEntities((match[1] ?? '').replace(/<[^>]*>/g, '')).trim();
    if (value) locations.push(value);
  }
  return [...new Set(locations)].sort();
}

function successfulFetchEvidence(response, requestedUrl, purposes) {
  return {
    requestedUrl,
    finalUrl: response.url,
    purposes: [...purposes].sort(),
    statusCode: response.statusCode,
    contentType: contentType(response) || null,
    bodyBytes: response.body.byteLength,
    hops: response.hops.map((hop) => ({
      url: hop.url,
      statusCode: hop.statusCode,
      resolvedAddresses: [...hop.resolvedAddresses],
      connectedAddress: hop.connectedAddress,
      location: hop.location,
    })),
  };
}

function failedFetchEvidence(requestedUrl, purposes, error) {
  const retainedHops = error instanceof OutboundUrlPolicyError
    ? (error.details.completedHops ?? error.details.hops)
    : null;
  const hops = Array.isArray(retainedHops) ? retainedHops.map((hop) => ({
    url: String(hop?.url ?? ''),
    statusCode: Number(hop?.statusCode ?? 0),
    resolvedAddresses: Array.isArray(hop?.resolvedAddresses)
      ? hop.resolvedAddresses.map(String)
      : [],
    connectedAddress: String(hop?.connectedAddress ?? ''),
    location: typeof hop?.location === 'string' ? hop.location : null,
  })) : [];
  return {
    requestedUrl,
    finalUrl: null,
    purposes: [...purposes].sort(),
    statusCode: null,
    contentType: null,
    bodyBytes: 0,
    hops,
    failure: outboundFailure(error),
  };
}

function stableDiagnosticKey(item) {
  return `${item.code}\0${item.source}\0${item.url ?? ''}\0${item.detail}`;
}

/**
 * Builds a live, evidence-only route inventory. Network access is intentionally
 * not injectable as a raw fetch function: callers may inject DNS and transport
 * primitives, but every request still passes through createOriginBoundFetcher.
 */
export async function buildLiveRouteInventory(options) {
  if (!isRecord(options)) throw new TypeError('Live route inventory options must be an object.');
  const origin = normalizeExactHttpOrigin(options.origin, { label: 'Live route inventory origin' });
  if (!Array.isArray(options.catalogRoutes)) {
    throw new TypeError('catalogRoutes must be an injected array, including when the catalog is empty.');
  }
  if (options.deploymentRoutes !== undefined && !Array.isArray(options.deploymentRoutes)) {
    throw new TypeError('deploymentRoutes must be an array when supplied.');
  }
  if (options.entryPoints !== undefined && !Array.isArray(options.entryPoints)) {
    throw new TypeError('entryPoints must be an array when supplied.');
  }
  if (!isRecord(options.outbound)) {
    throw new TypeError('An outbound policy configuration is required for live route discovery.');
  }
  if (Object.hasOwn(options.outbound, 'origin')) {
    throw new TypeError('outbound.origin must not be supplied; the inventory origin is the sole network authority.');
  }

  const limits = normalizeLimits(options.limits);
  const fetchOrigin = createOriginBoundFetcher({ ...options.outbound, origin });
  const fetchCache = new Map();
  const fetchEvidenceEntries = new Set();

  const fetchResource = async (rawUrl, purpose) => {
    const assessed = canonicalSameOriginUrl(rawUrl, origin, origin);
    if (!assessed.accepted) {
      throw new OutboundUrlPolicyError(
        assessed.code === 'cross-origin' ? 'OUTBOUND_ORIGIN_DENIED' : 'OUTBOUND_URL_INVALID',
        assessed.detail,
      );
    }
    const requestedUrl = assessed.url;
    let entry = fetchCache.get(requestedUrl);
    if (!entry) {
      const purposes = new Set();
      entry = {
        requestedUrl,
        purposes,
        promise: fetchOrigin(requestedUrl).then(
          (response) => ({ ok: true, response }),
          (error) => ({ ok: false, error }),
        ),
      };
      fetchCache.set(requestedUrl, entry);
      fetchEvidenceEntries.add(entry);
    }
    entry.purposes.add(purpose);
    const result = await entry.promise;
    if (!result.ok) throw result.error;
    if (!fetchCache.has(result.response.url)) fetchCache.set(result.response.url, entry);
    return result.response;
  };

  const discoveryFailures = [];
  const discoveryExclusions = [];
  const discoveryLimitations = [];
  const sitemapDocuments = [];
  const sitemapCandidates = [];
  const sitemapQueue = [];
  const queuedSitemaps = new Set();
  let sitemapBytes = 0;

  const recordRejectedDiscoveryUrl = (source, value, assessment, from) => {
    discoveryExclusions.push({
      code: assessment.code,
      source,
      url: String(value),
      from,
      detail: assessment.detail,
    });
  };

  let robots = { url: `${origin}/robots.txt`, statusCode: null, bodyBytes: 0, sitemapDirectives: 0 };
  let robotsSitemaps = [];
  try {
    const response = await fetchResource(`${origin}/robots.txt`, 'robots');
    robots = {
      url: `${origin}/robots.txt`,
      statusCode: response.statusCode,
      bodyBytes: response.body.byteLength,
      sitemapDirectives: 0,
    };
    if (response.statusCode >= 200 && response.statusCode < 300) {
      robotsSitemaps = extractRobotsSitemaps(response.text);
      robots.sitemapDirectives = robotsSitemaps.length;
    } else {
      discoveryLimitations.push({
        code: 'source-unavailable',
        source: 'robots',
        url: `${origin}/robots.txt`,
        detail: `robots.txt returned HTTP ${response.statusCode}.`,
      });
    }
  } catch (error) {
    discoveryFailures.push({
      ...outboundFailure(error),
      source: 'robots',
      url: `${origin}/robots.txt`,
    });
    discoveryLimitations.push({
      code: 'source-unavailable',
      source: 'robots',
      url: `${origin}/robots.txt`,
      detail: 'robots.txt could not be fetched through the origin-bound client.',
    });
  }

  for (const value of robotsSitemaps) {
    const assessment = canonicalSameOriginUrl(value, `${origin}/robots.txt`, origin);
    if (!assessment.accepted) {
      recordRejectedDiscoveryUrl('robots', value, assessment, `${origin}/robots.txt`);
      continue;
    }
    if (!queuedSitemaps.has(assessment.url)) {
      sitemapQueue.push({ url: assessment.url, depth: 0, from: `${origin}/robots.txt` });
      queuedSitemaps.add(assessment.url);
    }
  }
  if (sitemapQueue.length === 0) {
    const fallback = `${origin}/sitemap.xml`;
    sitemapQueue.push({ url: fallback, depth: 0, from: null });
    queuedSitemaps.add(fallback);
  }

  for (let offset = 0; offset < sitemapQueue.length; offset += 1) {
    const document = sitemapQueue[offset];
    if (offset >= limits.maxSitemaps) {
      discoveryLimitations.push({
        code: 'sitemap-count-limit',
        source: 'sitemap',
        url: document.url,
        detail: `The ${limits.maxSitemaps}-sitemap document limit was reached.`,
      });
      break;
    }
    if (document.depth > limits.maxSitemapDepth) {
      discoveryLimitations.push({
        code: 'sitemap-depth-limit',
        source: 'sitemap',
        url: document.url,
        detail: `The sitemap depth limit of ${limits.maxSitemapDepth} was reached.`,
      });
      continue;
    }
    let response;
    try {
      response = await fetchResource(document.url, 'sitemap');
    } catch (error) {
      discoveryFailures.push({
        ...outboundFailure(error),
        source: 'sitemap',
        url: document.url,
      });
      continue;
    }
    const type = contentType(response);
    const kind = sitemapShape(response.text);
    const bytes = response.body.byteLength;
    sitemapDocuments.push({
      requestedUrl: document.url,
      finalUrl: response.url,
      from: document.from,
      depth: document.depth,
      statusCode: response.statusCode,
      contentType: type || null,
      bodyBytes: bytes,
      kind,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      discoveryFailures.push({
        code: 'sitemap-http-status',
        source: 'sitemap',
        url: document.url,
        detail: `Sitemap returned HTTP ${response.statusCode}.`,
      });
      continue;
    }
    sitemapBytes += bytes;
    if (sitemapBytes > limits.maxSitemapBytes) {
      discoveryLimitations.push({
        code: 'sitemap-byte-limit',
        source: 'sitemap',
        url: document.url,
        detail: `The ${limits.maxSitemapBytes}-byte aggregate sitemap limit was exceeded.`,
      });
      break;
    }
    if (kind === 'unknown') {
      discoveryFailures.push({
        code: 'sitemap-malformed',
        source: 'sitemap',
        url: document.url,
        detail: 'Sitemap body did not contain a recognizable sitemapindex or urlset root.',
      });
      continue;
    }
    if (type && !XML_CONTENT_TYPES.has(type) && !type.endsWith('+xml')) {
      discoveryLimitations.push({
        code: 'sitemap-content-type-unexpected',
        source: 'sitemap',
        url: document.url,
        detail: `Sitemap used unexpected content type ${type}.`,
      });
    }
    for (const value of extractSitemapLocations(response.text)) {
      const assessment = canonicalSameOriginUrl(value, response.url, origin);
      if (!assessment.accepted) {
        recordRejectedDiscoveryUrl('sitemap', value, assessment, document.url);
        continue;
      }
      if (kind === 'url-set') {
        sitemapCandidates.push({ url: assessment.url, from: document.url });
        continue;
      }
      if (!queuedSitemaps.has(assessment.url)) {
        sitemapQueue.push({ url: assessment.url, depth: document.depth + 1, from: document.url });
        queuedSitemaps.add(assessment.url);
      }
    }
  }

  if (sitemapCandidates.length === 0) {
    discoveryLimitations.push({
      code: 'source-unavailable',
      source: 'sitemap',
      url: null,
      detail: 'No same-origin page routes were recovered from the available sitemap documents.',
    });
  }

  let staticNavigationCandidates = [];
  try {
    const response = await fetchResource(origin, 'static-navigation');
    if (response.statusCode >= 200 && response.statusCode < 400 && contentType(response).startsWith('text/html')) {
      staticNavigationCandidates = parseInertHtmlNavigation(response.text, response.url);
    } else {
      discoveryLimitations.push({
        code: 'source-unavailable',
        source: 'static-navigation',
        url: origin,
        detail: `Root navigation source returned HTTP ${response.statusCode} with ${contentType(response) || 'no content type'}.`,
      });
    }
  } catch (error) {
    discoveryFailures.push({
      ...outboundFailure(error),
      source: 'static-navigation',
      url: origin,
    });
    discoveryLimitations.push({
      code: 'source-unavailable',
      source: 'static-navigation',
      url: origin,
      detail: 'Root static navigation could not be fetched through the origin-bound client.',
    });
  }
  discoveryLimitations.push({
    code: 'not-browser-rendered',
    source: 'static-navigation',
    url: origin,
    detail: 'Navigation candidates were parsed from inert root HTML; JavaScript was not executed and browser-rendered navigation was not observed.',
  });

  const deploymentMissing = options.deploymentRoutes === undefined;
  if (deploymentMissing) {
    discoveryLimitations.push({
      code: 'source-unavailable',
      source: 'deployment-manifest',
      url: null,
      detail: 'No deployment route manifest was supplied by the caller.',
    });
  }

  const urlPolicy = async ({ url }) => {
    const assessment = canonicalSameOriginUrl(url, origin, origin);
    return assessment.accepted
      ? { allowed: true }
      : { allowed: false, code: assessment.code, detail: assessment.detail };
  };

  const fetchPage = async ({ url }) => {
    const response = await fetchResource(url, 'route-crawl');
    if (response.redirects.length > 0 && response.url !== url) {
      return {
        status: response.redirects[0].statusCode,
        bodyBytes: 0,
        redirectUrl: response.url,
      };
    }
    const type = contentType(response);
    const isHtml = type.startsWith('text/html');
    const candidates = isHtml ? parseInertHtmlNavigation(response.text, response.url) : [];
    return {
      status: response.statusCode,
      contentType: type,
      body: response.body,
      links: candidates.filter((candidate) => candidate.discoveryKind === 'link'),
      forms: candidates.filter((candidate) => candidate.discoveryKind === 'form'),
    };
  };

  const inventory = await buildRouteInventory({
    origin,
    adapters: {
      catalog: [...options.catalogRoutes],
      'deployment-manifest': deploymentMissing
        ? {
            candidates: [],
            limitations: [{ code: 'source-unavailable', detail: 'No deployment route manifest was supplied by the caller.' }],
          }
        : [...options.deploymentRoutes],
      sitemap: {
        candidates: uniqueSorted(sitemapCandidates, stableCandidateKey),
        ...(sitemapCandidates.length === 0
          ? { limitations: [{ code: 'source-unavailable', detail: 'No same-origin page routes were recovered from sitemap documents.' }] }
          : {}),
      },
      'rendered-navigation': {
        candidates: staticNavigationCandidates,
        limitations: [{
          code: 'source-partial',
          detail: 'Static root HTML only: JavaScript was not executed and browser-rendered navigation was not observed.',
        }],
      },
    },
    entryPoints: options.entryPoints ?? ['/'],
    fetchPage,
    urlPolicy,
    limits: options.routeInventoryLimits,
    now: options.now,
  });

  const fetchEvidence = [];
  for (const entry of fetchEvidenceEntries) {
    const result = await entry.promise;
    fetchEvidence.push(result.ok
      ? successfulFetchEvidence(result.response, entry.requestedUrl, entry.purposes)
      : failedFetchEvidence(entry.requestedUrl, entry.purposes, result.error));
  }
  fetchEvidence.sort((left, right) => left.requestedUrl.localeCompare(right.requestedUrl));

  const failures = uniqueSorted(discoveryFailures, stableDiagnosticKey);
  const exclusions = uniqueSorted(discoveryExclusions, stableDiagnosticKey);
  const limitations = uniqueSorted(discoveryLimitations, stableDiagnosticKey);

  return {
    schemaVersion: LIVE_ROUTE_INVENTORY_SCHEMA_VERSION,
    kind: 'live-route-inventory-diagnostic',
    origin,
    capabilities: {
      scriptExecution: false,
      browserRendering: false,
      formSubmission: false,
      productOracleDerivation: false,
      findingDerivation: false,
    },
    limits: { ...limits },
    sources: {
      catalog: { supplied: true, candidateCount: options.catalogRoutes.length },
      deploymentManifest: {
        supplied: !deploymentMissing,
        candidateCount: options.deploymentRoutes?.length ?? 0,
      },
      robots,
      sitemap: {
        documents: sitemapDocuments.sort((left, right) => left.requestedUrl.localeCompare(right.requestedUrl)),
        candidateCount: uniqueSorted(sitemapCandidates, stableCandidateKey).length,
        totalBodyBytes: sitemapBytes,
      },
      navigation: {
        mode: 'static-root-html',
        browserRendered: false,
        candidateCount: staticNavigationCandidates.length,
      },
    },
    fetchEvidence,
    failures,
    exclusions,
    limitations,
    inventory,
  };
}
