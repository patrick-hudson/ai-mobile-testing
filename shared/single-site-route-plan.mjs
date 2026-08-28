import { canonicalSha256 } from './run-compiler.mjs';

export const SINGLE_SITE_ROUTE_PLAN_SCHEMA_VERSION = 1;
export const GENERIC_ROUTE_AUDIT_ID = 'ENV-002';
export const GENERIC_ROUTE_ORACLE_REVISION = 'generic-page-inspection-v1';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new TypeError(message);
}

function pathFromDefinition(definition) {
  if (!isRecord(definition) || typeof definition.id !== 'string' || typeof definition.title !== 'string') return null;
  if (!definition.id.startsWith('PAGE-')) return null;
  const match = /^Page audit: (\/[^?#]*)$/.exec(definition.title.trim());
  if (!match) fail(`Reviewed route definition ${definition.id} does not expose its exact path in the generated title.`);
  const path = normalizedRoutePath(match[1]);
  return { auditId: definition.id, path };
}

function normalizedRoutePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#')) {
    fail('Reviewed route paths must be absolute same-origin paths without query or fragment.');
  }
  const parsed = new URL(value, 'https://route-plan.invalid');
  const collapsed = parsed.pathname.replace(/\/{2,}/g, '/');
  return collapsed === '/' ? '/' : collapsed.replace(/\/$/, '');
}

function reviewedRoutes(pluginRegistry) {
  if (!isRecord(pluginRegistry) || !Array.isArray(pluginRegistry.plugins)) fail('Route planning requires the generated plugin registry.');
  const routes = pluginRegistry.plugins
    .flatMap((plugin) => Array.isArray(plugin?.auditDefinitions) ? plugin.auditDefinitions : [])
    .map(pathFromDefinition)
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path) || left.auditId.localeCompare(right.auditId));
  if (new Set(routes.map(({ path }) => path)).size !== routes.length) fail('Reviewed route catalog contains duplicate normalized paths.');
  return routes;
}

export function compileSingleSiteRouteInventoryPlan({ pluginRegistry, coverageManifest }) {
  if (!isRecord(coverageManifest) || !isRecord(coverageManifest.scope)
    || !Array.isArray(coverageManifest.selectedDefinitions) || !Array.isArray(coverageManifest.selectedTargets)) {
    fail('Route planning requires a compiled Definition Coverage Manifest.');
  }
  const routes = reviewedRoutes(pluginRegistry);
  const routeDefinitionsSelected = coverageManifest.selectedDefinitions.some(({ auditId }) => (
    auditId === GENERIC_ROUTE_AUDIT_ID
  ));
  const required = coverageManifest.scope.qualifier === 'FULL' || routeDefinitionsSelected;
  const targets = coverageManifest.selectedTargets
    .map(({ targetId, deviceClass, engine }) => ({ targetId, deviceClass, engine }))
    .filter(({ targetId }) => typeof targetId === 'string')
    .sort((left, right) => (
      Number(right.deviceClass === 'desktop') - Number(left.deviceClass === 'desktop')
      || Number(right.engine === 'chromium') - Number(left.engine === 'chromium')
      || left.targetId.localeCompare(right.targetId)
    ));
  const body = {
    schemaVersion: SINGLE_SITE_ROUTE_PLAN_SCHEMA_VERSION,
    kind: 'single-site-route-inventory-plan',
    coverageManifestDigest: coverageManifest.manifestDigest,
    required,
    reason: required
      ? 'FULL scope or selected route coverage requires live route inventory before browser execution.'
      : 'Targeted scope omitted route coverage; discovery is intentionally not executed and is not a Coverage Gap.',
    reviewedRoutes: routes,
    entryPoints: ['/'],
    canonicalTargetId: required ? targets[0]?.targetId ?? null : null,
  };
  if (required && body.canonicalTargetId === null) fail('Required route inventory has no selected canonical browser target.');
  return Object.freeze({ ...body, planDigest: canonicalSha256(body) });
}

export function verifySingleSiteRouteInventoryPlan(value) {
  if (!isRecord(value) || value.schemaVersion !== SINGLE_SITE_ROUTE_PLAN_SCHEMA_VERSION
    || value.kind !== 'single-site-route-inventory-plan' || typeof value.required !== 'boolean'
    || !SHA256.test(value.coverageManifestDigest ?? '') || typeof value.reason !== 'string' || !Array.isArray(value.reviewedRoutes)
    || !Array.isArray(value.entryPoints) || !SHA256.test(value.planDigest ?? '')) return false;
  const { planDigest, ...body } = value;
  if (canonicalSha256(body) !== planDigest) return false;
  try {
    const paths = value.reviewedRoutes.map((route) => {
      if (!isRecord(route) || typeof route.auditId !== 'string' || !route.auditId.startsWith('PAGE-')) fail('invalid audit');
      return normalizedRoutePath(route.path);
    });
    if (new Set(paths).size !== paths.length) return false;
    if (value.entryPoints.length < 1 || value.entryPoints.some((path) => normalizedRoutePath(path) !== path)) return false;
    if (value.required !== (typeof value.canonicalTargetId === 'string' && value.canonicalTargetId.length > 0)) return false;
  } catch {
    return false;
  }
  return true;
}

function normalizedInventoryPath(value) {
  try {
    return normalizedRoutePath(new URL(value).pathname);
  } catch {
    return null;
  }
}

function finding(parts, route, title, detail) {
  return {
    id: `FINDING-${canonicalSha256(parts).slice('sha256:'.length, 'sha256:'.length + 24).toUpperCase()}`,
    severity: 'P1',
    auditId: GENERIC_ROUTE_AUDIT_ID,
    reviewedAuditId: route.auditId ?? null,
    executionId: 'route-inventory',
    targetId: null,
    source: 'route-inventory',
    title,
    detail,
    route: route.path,
  };
}

function availableDeclarationSources(diagnostic) {
  const sources = new Set();
  if (diagnostic.sources?.deploymentManifest?.supplied === true) sources.add('deployment-manifest');
  if (Array.isArray(diagnostic.sources?.sitemap?.documents) && diagnostic.sources.sitemap.documents.some((document) => (
    isRecord(document)
    && Number.isInteger(document.statusCode)
    && document.statusCode >= 200
    && document.statusCode < 300
    && ['sitemap-index', 'url-set'].includes(document.kind)
  ))) sources.add('sitemap');
  return sources;
}

function routeFailureEvidence(diagnostic, route) {
  const response = diagnostic.inventory.responses.find(({ url }) => url === route.url) ?? null;
  const failures = uniqueSorted([
    ...(Array.isArray(diagnostic.failures) ? diagnostic.failures : []),
    ...(Array.isArray(diagnostic.inventory.failures) ? diagnostic.inventory.failures : []),
  ].filter((failure) => isRecord(failure) && failure.url === route.url), limitationKey);
  return { response, failures };
}

function unreviewedRouteFailureFinding(diagnostic, route, path) {
  const { response, failures } = routeFailureEvidence(diagnostic, route);
  const discoverySources = [...new Set((route.sources ?? [])
    .map((source) => isRecord(source) ? source.source : null)
    .filter((source) => typeof source === 'string'))]
    .sort();
  const discoverySummary = discoverySources.length > 0
    ? `Discovered by ${discoverySources.join(' and ')} evidence.`
    : 'No discovery-source contribution was retained.';
  const failureSummary = failures.length > 0
    ? failures.map(({ code, detail }) => `${code}: ${detail}`).join(' ')
    : 'No lower-level failure detail was retained.';
  if (route.disposition === 'unreachable') {
    return finding(
      ['unreviewed-route-unreachable', route.url, response?.status ?? null, route.sources ?? [], failures],
      { auditId: null, path: route.url },
      `Inventoried route is unreachable: ${path}`,
      response
        ? `${discoverySummary} The frozen route inventory observed HTTP ${response.status}. ${failureSummary}`
        : `${discoverySummary} The frozen route inventory marked this route unreachable. ${failureSummary}`,
    );
  }
  return finding(
    ['unreviewed-route-fetch-failed', route.url, route.sources ?? [], failures],
    { auditId: null, path: route.url },
    `Inventoried route fetch failed: ${path}`,
    `${discoverySummary} The frozen route inventory could not fetch ${route.url}. ${failureSummary}`,
  );
}

function limitationKey(value) {
  return `${value.source ?? ''}\0${value.code ?? ''}\0${value.url ?? ''}\0${value.detail ?? ''}`;
}

function uniqueSorted(values, key) {
  return [...new Map(values.map((value) => [key(value), value])).values()]
    .sort((left, right) => key(left).localeCompare(key(right)));
}

export function reconcileSingleSiteRouteInventory({ jobId, attemptId, coverageManifestDigest, plan, diagnostic }) {
  if (!verifySingleSiteRouteInventoryPlan(plan) || plan.required !== true) fail('A verified required route plan is needed for reconciliation.');
  if (!SHA256.test(coverageManifestDigest ?? '')) fail('Route inventory requires its coverage-manifest digest binding.');
  if (plan.coverageManifestDigest !== coverageManifestDigest) fail('Route inventory plan belongs to a different Coverage Manifest.');
  if (!isRecord(diagnostic) || diagnostic.schemaVersion !== 1 || diagnostic.kind !== 'live-route-inventory-diagnostic'
    || !isRecord(diagnostic.inventory) || !Array.isArray(diagnostic.inventory.routes)) {
    fail('Live route inventory diagnostic is malformed.');
  }
  const inventoryDigest = canonicalSha256(diagnostic);
  const routesByPath = new Map();
  for (const route of diagnostic.inventory.routes) {
    const path = normalizedInventoryPath(route.url);
    if (!path) continue;
    const existing = routesByPath.get(path);
    if (!existing || (existing.query && !route.query)) routesByPath.set(path, route);
  }
  const declarationSources = availableDeclarationSources(diagnostic);
  const reviewedByPath = new Map(plan.reviewedRoutes.map((route) => [route.path, route]));
  const reviewedFindings = [];
  for (const reviewed of plan.reviewedRoutes) {
    const observed = routesByPath.get(reviewed.path);
    const response = observed
      ? diagnostic.inventory.responses.find(({ url }) => normalizedInventoryPath(url) === reviewed.path)
      : null;
    if (!observed || !response || response.status >= 400 || observed.disposition !== 'included') {
      reviewedFindings.push(finding(
        ['reviewed-route-unreachable', reviewed.auditId, reviewed.path, observed?.disposition ?? 'absent', response?.status ?? null],
        reviewed,
        `Reviewed route is missing or unreachable: ${reviewed.path}`,
        response
          ? `The frozen route inventory observed HTTP ${response.status} with disposition ${observed?.disposition ?? 'absent'}.`
          : 'The frozen route inventory did not retain a successful HTML response for this reviewed route.',
      ));
      continue;
    }
    const declared = observed.sources?.some(({ source }) => declarationSources.has(source));
    if (declarationSources.size > 0 && !declared) {
      const sourceList = [...declarationSources].sort();
      reviewedFindings.push(finding(
        ['reviewed-route-undeclared', reviewed.auditId, reviewed.path, sourceList],
        reviewed,
        `Reviewed route is absent from deployment declarations: ${reviewed.path}`,
        `The ${sourceList.join(' and ')} source${sourceList.length === 1 ? ' was' : 's were'} explicitly available, but this reviewed route appeared only through catalog or crawl evidence.`,
      ));
    }
  }

  const genericExecutions = [];
  const coverageGaps = [];
  for (const route of diagnostic.inventory.routes) {
    const path = normalizedInventoryPath(route.url);
    if (!path || reviewedByPath.has(path)
      || !['included', 'unreachable', 'fetch-failed'].includes(route.disposition)) continue;
    if (route.disposition === 'included') {
      const hash = canonicalSha256(['generic-route', route.url]).slice('sha256:'.length, 'sha256:'.length + 24).toUpperCase();
      const caseId = `GENERIC-ROUTE-${hash}`;
      genericExecutions.push({
        executionId: `${caseId}@${plan.canonicalTargetId}`,
        caseId,
        auditId: GENERIC_ROUTE_AUDIT_ID,
        targetId: plan.canonicalTargetId,
        url: route.url,
        path,
        sources: structuredClone(route.sources ?? []),
        productOracleVariant: GENERIC_ROUTE_ORACLE_REVISION,
      });
    } else {
      reviewedFindings.push(unreviewedRouteFailureFinding(diagnostic, route, path));
    }
    coverageGaps.push({
      kind: 'unreviewed-inventoried-route',
      auditId: GENERIC_ROUTE_AUDIT_ID,
      route: route.url,
      detail: route.disposition === 'included'
        ? `Inventoried route ${route.url} has generic inspection but no reviewed route-specific Product Oracle.`
        : `Inventoried route ${route.url} could not receive generic inspection after ${route.disposition}, and has no reviewed route-specific Product Oracle.`,
    });
  }
  genericExecutions.sort((left, right) => left.executionId.localeCompare(right.executionId));
  coverageGaps.sort((left, right) => left.route.localeCompare(right.route));

  const limitations = [
    ...(Array.isArray(diagnostic.limitations) ? diagnostic.limitations : []),
    ...(Array.isArray(diagnostic.inventory.limitations) ? diagnostic.inventory.limitations : []),
    ...(Array.isArray(diagnostic.inventory.bounds) ? diagnostic.inventory.bounds
      .filter(({ exhausted }) => exhausted === true)
      .map(({ code, limit, observed }) => ({
        code: `bound-${code}`,
        source: 'crawl',
        url: null,
        detail: `Route inventory ${code} bound was exhausted (${observed} observed; limit ${limit}).`,
      })) : []),
  ];
  const body = {
    schemaVersion: SINGLE_SITE_ROUTE_PLAN_SCHEMA_VERSION,
    kind: 'single-site-route-inventory-publication',
    mode: 'single-site',
    jobId,
    attemptId,
    coverageManifestDigest,
    routePlanDigest: plan.planDigest,
    inventoryDigest,
    diagnostic,
    reviewedFindings: reviewedFindings.sort((left, right) => left.id.localeCompare(right.id)),
    genericExecutions,
    coverageGaps,
    limitations: uniqueSorted(limitations, limitationKey),
  };
  return Object.freeze({ ...body, publicationDigest: canonicalSha256(body) });
}

export function verifySingleSiteRouteInventoryPublication(value, expected = {}) {
  if (!isRecord(value) || value.schemaVersion !== SINGLE_SITE_ROUTE_PLAN_SCHEMA_VERSION
    || value.kind !== 'single-site-route-inventory-publication' || value.mode !== 'single-site'
    || !SHA256.test(value.coverageManifestDigest ?? '') || !SHA256.test(value.routePlanDigest ?? '')
    || !SHA256.test(value.inventoryDigest ?? '') || !SHA256.test(value.publicationDigest ?? '')
    || !isRecord(value.diagnostic) || !Array.isArray(value.reviewedFindings)
    || !Array.isArray(value.genericExecutions) || !Array.isArray(value.coverageGaps)
    || !Array.isArray(value.limitations)) return false;
  const { publicationDigest, ...body } = value;
  if (canonicalSha256(body) !== publicationDigest || canonicalSha256(value.diagnostic) !== value.inventoryDigest) return false;
  if (expected.jobId !== undefined && value.jobId !== expected.jobId) return false;
  if (expected.attemptId !== undefined && value.attemptId !== expected.attemptId) return false;
  if (expected.coverageManifestDigest !== undefined && value.coverageManifestDigest !== expected.coverageManifestDigest) return false;
  if (expected.routePlanDigest !== undefined && value.routePlanDigest !== expected.routePlanDigest) return false;
  const ids = new Set();
  const routes = new Set();
  const inventoryRoutes = new Map();
  if (!Array.isArray(value.diagnostic.inventory?.routes)) return false;
  for (const route of value.diagnostic.inventory.routes) {
    if (!isRecord(route) || typeof route.url !== 'string' || inventoryRoutes.has(route.url)) return false;
    inventoryRoutes.set(route.url, route);
  }
  for (const execution of value.genericExecutions) {
    if (!isRecord(execution) || typeof execution.executionId !== 'string' || typeof execution.caseId !== 'string'
      || execution.executionId !== `${execution.caseId}@${execution.targetId}` || execution.auditId !== GENERIC_ROUTE_AUDIT_ID
      || typeof execution.targetId !== 'string' || !execution.targetId
      || execution.productOracleVariant !== GENERIC_ROUTE_ORACLE_REVISION || ids.has(execution.executionId)
      || !Array.isArray(execution.sources) || execution.sources.length === 0) return false;
    let parsed;
    try { parsed = new URL(execution.url); } catch { return false; }
    if (parsed.origin !== value.diagnostic.origin || normalizedRoutePath(parsed.pathname) !== execution.path
      || routes.has(execution.url)) return false;
    if (execution.sources.some((source) => !isRecord(source) || typeof source.source !== 'string'
      || !Number.isSafeInteger(source.depth) || source.depth < 0
      || !(source.from === null || typeof source.from === 'string'))) return false;
    ids.add(execution.executionId);
    routes.add(execution.url);
  }
  const unreviewedFailureRoutes = new Set();
  if (value.reviewedFindings.some((item) => {
    if (!isRecord(item) || item.source !== 'route-inventory'
      || item.auditId !== GENERIC_ROUTE_AUDIT_ID
      || !(item.reviewedAuditId === null || (typeof item.reviewedAuditId === 'string' && item.reviewedAuditId.startsWith('PAGE-')))
      || typeof item.title !== 'string' || typeof item.detail !== 'string' || typeof item.route !== 'string') return true;
    if (item.reviewedAuditId === null) {
      const observed = inventoryRoutes.get(item.route);
      if (!observed || !['unreachable', 'fetch-failed'].includes(observed.disposition)
        || unreviewedFailureRoutes.has(item.route)) return true;
      unreviewedFailureRoutes.add(item.route);
    }
    return false;
  })) return false;
  const gapRoutes = new Set();
  for (const gap of value.coverageGaps) {
    if (!isRecord(gap) || gap.kind !== 'unreviewed-inventoried-route'
      || gap.auditId !== GENERIC_ROUTE_AUDIT_ID || typeof gap.route !== 'string'
      || typeof gap.detail !== 'string' || gapRoutes.has(gap.route)) return false;
    const observed = inventoryRoutes.get(gap.route);
    if (!observed || (observed.disposition === 'included'
      ? !routes.has(gap.route)
      : !['unreachable', 'fetch-failed'].includes(observed.disposition) || !unreviewedFailureRoutes.has(gap.route))) return false;
    gapRoutes.add(gap.route);
  }
  if ([...routes].some((route) => !gapRoutes.has(route))
    || [...unreviewedFailureRoutes].some((route) => !gapRoutes.has(route))) return false;
  if (value.limitations.some((item) => !isRecord(item) || typeof item.code !== 'string'
    || typeof item.source !== 'string' || typeof item.detail !== 'string')) return false;
  return true;
}
