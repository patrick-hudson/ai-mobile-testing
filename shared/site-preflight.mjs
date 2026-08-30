import { createHash } from 'node:crypto';
import {
  OutboundUrlPolicyError,
  createOriginBoundFetcher,
  normalizeExactHttpOrigin,
} from './outbound-url-policy.mjs';

export const SITE_PREFLIGHT_SCHEMA_VERSION = 1;
export const QUITTING7OH_IDENTITY_CONTRACT_REVISION = 'quitting7oh-identity-v2';
export const QUITTING7OH_SENTINEL_PATH = '/start-here/welcome';

const REVIEWED_HOME_HEADINGS = Object.freeze([
  'Help quitting 7-OH',
  'A calm reference for getting off 7-OH and kratom synthetics.',
]);
const REQUIRED_MARKERS = Object.freeze([
  Object.freeze({ id: 'root-og-site-name', probe: 'root', expected: 'quitting7oh.org' }),
  Object.freeze({
    id: 'root-home-heading',
    probe: 'root',
    expected: REVIEWED_HOME_HEADINGS.join(' | '),
    accepted: REVIEWED_HOME_HEADINGS,
  }),
  Object.freeze({ id: 'manifest-name', probe: 'manifest', expected: 'quitting7oh.org' }),
  Object.freeze({ id: 'manifest-short-name', probe: 'manifest', expected: 'quitting7oh' }),
  Object.freeze({ id: 'sentinel-heading', probe: 'sentinel', expected: 'Welcome' }),
  Object.freeze({ id: 'sentinel-community-copy', probe: 'sentinel', expected: 'You’re in the right place.' }),
]);

const EXPLICIT_REVISION_HEADERS = Object.freeze([
  'cf-pages-commit-sha',
  'x-build-id',
  'x-deployment-id',
  'x-git-commit-sha',
]);
const EXPLICIT_REVISION_META_NAMES = new Set([
  'build-id',
  'deployment-id',
  'git-commit',
  'git-commit-sha',
  'revision',
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function decodeHtml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function tagAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function htmlTags(html, tagName) {
  return String(html).match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? [];
}

function metaValues(html) {
  const result = new Map();
  for (const tag of htmlTags(html, 'meta')) {
    const attributes = tagAttributes(tag);
    const key = (attributes.name ?? attributes.property ?? '').toLowerCase();
    if (key && attributes.content !== undefined && !result.has(key)) result.set(key, attributes.content);
  }
  return result;
}

function visibleText(html) {
  return decodeHtml(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstHeading(html) {
  const match = String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? visibleText(match[1]) : null;
}

function manifestHref(html, origin) {
  for (const tag of htmlTags(html, 'link')) {
    const attributes = tagAttributes(tag);
    const rel = (attributes.rel ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('manifest') || !attributes.href) continue;
    try {
      return new URL(attributes.href, origin).href;
    } catch {
      return attributes.href;
    }
  }
  return null;
}

function safeObserved(value) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function marker(id, probe, expected, observed, passed) {
  return Object.freeze({ id, probe, expected, observed: safeObserved(observed), passed });
}

function probeEvidence(id, requestedUrl, response, error = null) {
  if (!response) {
    return Object.freeze({
      id,
      requestedUrl,
      finalUrl: null,
      statusCode: null,
      contentType: null,
      etag: null,
      lastModified: null,
      hops: Object.freeze([]),
      error: error ? Object.freeze({
        code: error.code ?? 'PREFLIGHT_REQUEST_FAILED',
        message: error.message,
        details: Object.freeze({ ...(error.details ?? {}) }),
      }) : null,
    });
  }
  return Object.freeze({
    id,
    requestedUrl,
    finalUrl: response.url,
    statusCode: response.statusCode,
    contentType: response.headers['content-type'] ?? null,
    etag: response.headers.etag ?? null,
    lastModified: response.headers['last-modified'] ?? null,
    hops: response.hops,
    error: null,
  });
}

function preflightIssue(code, message, focusTarget = 'url', details = {}) {
  return Object.freeze({ code, message, focusTarget, details: Object.freeze({ ...details }) });
}

async function attemptProbe(fetcher, id, url) {
  try {
    const response = await fetcher(url);
    return { response, evidence: probeEvidence(id, new URL(url, response.url).href, response) };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      response: null,
      evidence: probeEvidence(id, String(url), null, normalized),
      error: normalized,
    };
  }
}

function successfulHtmlProbe(probe) {
  return Boolean(probe.response
    && probe.response.statusCode >= 200
    && probe.response.statusCode < 300
    && /(?:text\/html|application\/xhtml\+xml)/i.test(probe.response.headers['content-type'] ?? 'text/html'));
}

function extractAssetPaths(html, origin) {
  const values = [];
  for (const tag of [...htmlTags(html, 'script'), ...htmlTags(html, 'link')]) {
    const attributes = tagAttributes(tag);
    const candidate = attributes.src ?? attributes.href;
    if (!candidate) continue;
    const rel = (attributes.rel ?? '').toLowerCase().split(/\s+/);
    const isAsset = tag.toLowerCase().startsWith('<script')
      || rel.some((value) => ['stylesheet', 'modulepreload', 'preload'].includes(value));
    if (!isAsset) continue;
    try {
      const parsed = new URL(candidate, origin);
      if (parsed.origin !== origin || parsed.username || parsed.password || parsed.hash) continue;
      values.push(`${parsed.pathname}${parsed.search}`);
    } catch {
      // Invalid assets are ignored here; identity markers remain independent.
    }
  }
  return [...new Set(values)].sort();
}

function explicitRevisionSignals(probes) {
  const signals = [];
  for (const probe of probes) {
    if (!probe.response) continue;
    for (const header of EXPLICIT_REVISION_HEADERS) {
      const value = safeObserved(probe.response.headers[header]);
      if (value) signals.push({ source: `header:${header}`, probe: probe.evidence.id, value });
    }
    if (probe.evidence.id !== 'manifest') {
      for (const [name, value] of metaValues(probe.response.text)) {
        if (EXPLICIT_REVISION_META_NAMES.has(name) && safeObserved(value)) {
          signals.push({ source: `meta:${name}`, probe: probe.evidence.id, value: safeObserved(value) });
        }
      }
    }
  }
  return signals.sort((left, right) => `${left.source}:${left.probe}:${left.value}`.localeCompare(`${right.source}:${right.probe}:${right.value}`));
}

function deriveDeploymentRevision(origin, probes) {
  const explicit = explicitRevisionSignals(probes);
  if (explicit.length > 0) {
    const distinct = [...new Set(explicit.map(({ value }) => value))];
    if (distinct.length === 1) {
      return Object.freeze({
        status: 'verified',
        source: 'explicit-build-id',
        fingerprint: digest({ origin, value: distinct[0] }),
        signals: Object.freeze(explicit.map(Object.freeze)),
        limitation: null,
      });
    }
    return Object.freeze({
      status: 'unavailable',
      source: null,
      fingerprint: null,
      signals: Object.freeze(explicit.map(Object.freeze)),
      limitation: 'conflicting-explicit-build-identifiers',
    });
  }

  const html = probes.filter(successfulHtmlProbe).map(({ response }) => response.text).join('\n');
  const assets = extractAssetPaths(html, origin);
  const validators = probes.flatMap(({ evidence }) => [
    evidence.etag ? { probe: evidence.id, kind: 'etag', value: evidence.etag } : null,
    evidence.lastModified ? { probe: evidence.id, kind: 'last-modified', value: evidence.lastModified } : null,
  ]).filter(Boolean);
  if (assets.length > 0 && validators.length > 0) {
    return Object.freeze({
      status: 'verified',
      source: 'asset-manifest-validators',
      fingerprint: digest({ origin, assets, validators }),
      signals: Object.freeze([
        Object.freeze({ source: 'asset-paths', count: assets.length, digest: digest(assets) }),
        ...validators.map((entry) => Object.freeze({ source: `validator:${entry.kind}`, probe: entry.probe, value: entry.value })),
      ]),
      limitation: null,
    });
  }
  return Object.freeze({
    status: 'unavailable',
    source: null,
    fingerprint: null,
    signals: Object.freeze([]),
    limitation: assets.length === 0 ? 'no-reviewed-asset-manifest' : 'no-response-validator',
  });
}

function validateInput(input, options) {
  if (!input || typeof input !== 'object') throw new TypeError('Site preflight input must be an object.');
  if (input.deploymentRole !== 'preview' && input.deploymentRole !== 'production') {
    throw new TypeError('deploymentRole must be preview or production.');
  }
  const certificatePolicy = input.certificatePolicy ?? 'strict';
  if (certificatePolicy !== 'strict' && certificatePolicy !== 'preview-bypass') {
    throw new TypeError('certificatePolicy must be strict or preview-bypass.');
  }
  const origin = normalizeExactHttpOrigin(input.url, { allowedPorts: options.allowedPorts });
  return { origin, deploymentRole: input.deploymentRole, certificatePolicy };
}

export async function preflightQuitting7ohSite(input, options = {}) {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  let validated;
  try {
    validated = validateInput(input, options);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return Object.freeze({
      schemaVersion: SITE_PREFLIGHT_SCHEMA_VERSION,
      accepted: false,
      checkedAt,
      origin: null,
      deploymentRole: input?.deploymentRole ?? null,
      certificatePolicy: input?.certificatePolicy ?? 'strict',
      identityFingerprint: null,
      deploymentRevision: Object.freeze({ status: 'unavailable', source: null, fingerprint: null, signals: Object.freeze([]), limitation: 'preflight-input-invalid' }),
      evidenceAuthority: Object.freeze({ status: 'non-authoritative', reasons: Object.freeze(['preflight-rejected']) }),
      markers: Object.freeze([]),
      probes: Object.freeze([]),
      issues: Object.freeze([preflightIssue(
        error instanceof OutboundUrlPolicyError ? error.code : 'PREFLIGHT_INPUT_INVALID',
        normalized.message,
        input?.deploymentRole !== 'preview' && input?.deploymentRole !== 'production' ? 'deploymentRole' : 'url',
      )]),
      preflightDigest: null,
    });
  }

  let fetcher;
  try {
    fetcher = createOriginBoundFetcher({
      origin: validated.origin,
      allowedPorts: options.allowedPorts,
      lookup: options.lookup,
      transport: options.transport,
      timeoutMs: options.timeoutMs,
      maxBodyBytes: options.maxBodyBytes,
      maxRedirects: options.maxRedirects,
      deploymentRole: validated.deploymentRole,
      certificatePolicy: validated.certificatePolicy,
      previewBypassOrigins: options.previewBypassOrigins,
      tlsBypassRequestOptions: options.tlsBypassRequestOptions,
    });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return Object.freeze({
      schemaVersion: SITE_PREFLIGHT_SCHEMA_VERSION,
      accepted: false,
      checkedAt,
      origin: validated.origin,
      deploymentRole: validated.deploymentRole,
      certificatePolicy: validated.certificatePolicy,
      identityFingerprint: null,
      deploymentRevision: Object.freeze({ status: 'unavailable', source: null, fingerprint: null, signals: Object.freeze([]), limitation: 'request-policy-rejected' }),
      evidenceAuthority: Object.freeze({ status: 'non-authoritative', reasons: Object.freeze(['preflight-rejected']) }),
      markers: Object.freeze([]),
      probes: Object.freeze([]),
      issues: Object.freeze([preflightIssue(
        error instanceof OutboundUrlPolicyError ? error.code : 'PREFLIGHT_POLICY_INVALID',
        normalized.message,
        validated.certificatePolicy === 'preview-bypass' ? 'deploymentRole' : 'url',
      )]),
      preflightDigest: null,
    });
  }

  const issues = [];
  const root = await attemptProbe(fetcher, 'root', `${validated.origin}/`);
  const sentinel = await attemptProbe(fetcher, 'sentinel', `${validated.origin}${QUITTING7OH_SENTINEL_PATH}`);
  let manifest;
  const discoveredManifestHref = root.response ? manifestHref(root.response.text, validated.origin) : null;
  if (discoveredManifestHref) {
    manifest = await attemptProbe(fetcher, 'manifest', discoveredManifestHref);
  } else {
    manifest = {
      response: null,
      evidence: probeEvidence('manifest', `${validated.origin}/<manifest-link>`, null, new Error('Root page did not declare a web manifest.')),
    };
  }
  const probes = [root, manifest, sentinel];

  for (const probe of probes) {
    if (probe.error || !probe.response) {
      issues.push(preflightIssue(
        probe.error instanceof OutboundUrlPolicyError ? probe.error.code : 'PREFLIGHT_PROBE_FAILED',
        `${probe.evidence.id} probe failed: ${probe.evidence.error?.message ?? 'no response'}`,
        'url',
        { probe: probe.evidence.id, ...(probe.evidence.error?.details ?? {}) },
      ));
    } else if (probe.response.statusCode < 200 || probe.response.statusCode >= 300) {
      issues.push(preflightIssue(
        'PREFLIGHT_PROBE_STATUS',
        `${probe.evidence.id} probe returned HTTP ${probe.response.statusCode}.`,
        'url',
        { probe: probe.evidence.id, statusCode: probe.response.statusCode },
      ));
    } else {
      const contentType = probe.response.headers['content-type'] ?? '';
      const allowed = probe.evidence.id === 'manifest'
        ? /(?:application\/(?:manifest\+json|json)|text\/json)/i.test(contentType)
        : /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
      if (!allowed) {
        issues.push(preflightIssue(
          'PREFLIGHT_PROBE_CONTENT_TYPE',
          `${probe.evidence.id} probe returned an unexpected content type.`,
          'url',
          { probe: probe.evidence.id, contentType: safeObserved(contentType) },
        ));
      }
    }
  }

  const rootMeta = root.response ? metaValues(root.response.text) : new Map();
  let manifestObject = null;
  if (manifest.response) {
    try {
      manifestObject = JSON.parse(manifest.response.text);
    } catch {
      issues.push(preflightIssue('PREFLIGHT_MANIFEST_INVALID', 'The declared web manifest is not valid JSON.', 'url'));
    }
  }
  const rootText = root.response ? visibleText(root.response.text) : '';
  const sentinelText = sentinel.response ? visibleText(sentinel.response.text) : '';
  const observed = {
    'root-og-site-name': rootMeta.get('og:site_name') ?? null,
    'root-home-heading': root.response ? firstHeading(root.response.text) : null,
    'manifest-name': manifestObject?.name ?? null,
    'manifest-short-name': manifestObject?.short_name ?? null,
    'sentinel-heading': sentinel.response ? firstHeading(sentinel.response.text) : null,
    'sentinel-community-copy': sentinelText.includes('You’re in the right place.') ? 'You’re in the right place.' : null,
  };
  // Keep this explicit so a copied page cannot pass from one broad substring.
  const markers = REQUIRED_MARKERS.map((contract) => marker(
    contract.id,
    contract.probe,
    contract.expected,
    observed[contract.id],
    contract.accepted
      ? contract.accepted.includes(observed[contract.id])
      : observed[contract.id] === contract.expected,
  ));
  for (const failed of markers.filter(({ passed }) => !passed)) {
    issues.push(preflightIssue(
      'PREFLIGHT_IDENTITY_MARKER_MISSING',
      `${failed.probe} identity marker ${failed.id} did not match its reviewed value.`,
      'url',
      { markerId: failed.id },
    ));
  }
  // Ensure the heading is actually on the root response rather than only in metadata.
  if (!REVIEWED_HOME_HEADINGS.some((heading) => rootText.includes(heading))) {
    issues.push(preflightIssue('PREFLIGHT_ROOT_CONTENT_INVALID', 'Root page did not contain the reviewed home identity text.', 'url'));
  }

  const identityAccepted = markers.every(({ passed }) => passed) && probes.every(({ response }) =>
    response && response.statusCode >= 200 && response.statusCode < 300);
  const identityFingerprint = identityAccepted ? digest({
    contractRevision: QUITTING7OH_IDENTITY_CONTRACT_REVISION,
    markers: markers.map(({ id, expected }) => ({ id, expected })),
  }) : null;
  const deploymentRevision = deriveDeploymentRevision(validated.origin, probes);
  const accepted = identityAccepted && issues.every(({ code }) =>
    code !== 'PREFLIGHT_PROBE_FAILED'
    && code !== 'PREFLIGHT_PROBE_STATUS'
    && code !== 'PREFLIGHT_PROBE_CONTENT_TYPE'
    && code !== 'PREFLIGHT_MANIFEST_INVALID'
    && code !== 'PREFLIGHT_IDENTITY_MARKER_MISSING'
    && code !== 'PREFLIGHT_ROOT_CONTENT_INVALID');
  const authorityReasons = [];
  if (!accepted) authorityReasons.push('preflight-rejected');
  if (validated.certificatePolicy === 'preview-bypass') authorityReasons.push('development-certificate-bypass');
  if (deploymentRevision.status !== 'verified') authorityReasons.push('deployment-revision-unavailable');
  const evidenceAuthority = Object.freeze({
    status: authorityReasons.length === 0 ? 'authoritative' : 'non-authoritative',
    reasons: Object.freeze(authorityReasons.sort()),
  });
  const digestPayload = accepted ? {
    schemaVersion: SITE_PREFLIGHT_SCHEMA_VERSION,
    origin: validated.origin,
    deploymentRole: validated.deploymentRole,
    certificatePolicy: validated.certificatePolicy,
    identityFingerprint,
    deploymentRevisionFingerprint: deploymentRevision.fingerprint,
    authorityReasons,
    probes: probes.map(({ evidence }) => ({
      id: evidence.id,
      finalUrl: evidence.finalUrl,
      statusCode: evidence.statusCode,
      etag: evidence.etag,
      lastModified: evidence.lastModified,
    })),
  } : null;

  return Object.freeze({
    schemaVersion: SITE_PREFLIGHT_SCHEMA_VERSION,
    accepted,
    checkedAt,
    origin: validated.origin,
    deploymentRole: validated.deploymentRole,
    certificatePolicy: validated.certificatePolicy,
    identityFingerprint,
    deploymentRevision,
    evidenceAuthority,
    markers: Object.freeze(markers),
    probes: Object.freeze(probes.map(({ evidence }) => evidence)),
    issues: Object.freeze(issues),
    preflightDigest: digestPayload ? digest(digestPayload) : null,
  });
}

export const previewSitePreflight = preflightQuitting7ohSite;
