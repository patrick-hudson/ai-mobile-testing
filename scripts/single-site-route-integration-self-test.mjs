import assert from 'node:assert/strict';
import {
  compileSingleSiteRouteInventoryPlan,
  reconcileSingleSiteRouteInventory,
  verifySingleSiteRouteInventoryPlan,
  verifySingleSiteRouteInventoryPublication,
} from '../shared/single-site-route-plan.mjs';
import { canonicalSha256 } from '../shared/run-compiler.mjs';

const origin = 'https://beta.example.test';
const coverageManifest = {
  manifestDigest: `sha256:${'a'.repeat(64)}`,
  scope: { qualifier: 'FULL' },
  selectedDefinitions: [{ auditId: 'ENV-002', area: 'routes' }],
  selectedTargets: [{ targetId: 'single-site-desktop-chromium', deviceClass: 'desktop', engine: 'chromium' }],
};

function registry(paths = []) {
  return {
    plugins: [{
      auditDefinitions: paths.map((path, index) => ({ id: `PAGE-${String(index + 1).padStart(3, '0')}`, title: `Page audit: ${path}` })),
    }],
  };
}

function diagnostic(routes, {
  exhausted = false,
  limitations = [],
  deploymentManifest = { supplied: true, candidateCount: routes.length },
  sitemapDocuments = [],
  responses = routes.map(({ url }) => ({ url, depth: 0, status: 200, contentType: 'text/html', bytes: 100 })),
  failures = [],
} = {}) {
  return {
    schemaVersion: 1,
    kind: 'live-route-inventory-diagnostic',
    origin,
    capabilities: {
      scriptExecution: false,
      browserRendering: false,
      formSubmission: false,
      productOracleDerivation: false,
      findingDerivation: false,
    },
    limits: { maxSitemaps: 24, maxSitemapDepth: 4, maxSitemapBytes: 10_485_760 },
    sources: {
      catalog: { supplied: true, candidateCount: 0 },
      deploymentManifest,
      robots: null,
      sitemap: { documents: sitemapDocuments, candidateCount: routes.filter(({ sources }) => (
        sources.some(({ source }) => source === 'sitemap')
      )).length, totalBodyBytes: 0 },
      navigation: { mode: 'static-root-html', browserRendered: false, candidateCount: 0 },
    },
    fetchEvidence: [],
    failures: [],
    exclusions: [],
    limitations,
    inventory: {
      schemaVersion: 1,
      origin,
      limits: {},
      sources: [],
      routes,
      exclusions: [],
      failures,
      limitations: [],
      responses,
      redirects: [],
      bounds: [{ code: 'route-count', limit: 1, observed: routes.length, exhausted }],
      summary: {
        routes: routes.length,
        exclusions: 0,
        failures: failures.length,
        limitations: 0,
        responses: responses.length,
        redirects: 0,
        htmlBytesConsumed: routes.length * 100,
      },
    },
  };
}

function route(path, source, from = null) {
  return {
    url: `${origin}${path}`,
    path,
    query: '',
    disposition: 'included',
    sources: [{ source, from, depth: source === 'crawl' ? 1 : 0 }],
  };
}

function successfulSitemapDocument(path = '/sitemap.xml', kind = 'url-set') {
  return {
    requestedUrl: `${origin}${path}`,
    finalUrl: `${origin}${path}`,
    from: null,
    depth: 0,
    statusCode: 200,
    contentType: 'application/xml',
    bodyBytes: 64,
    kind,
  };
}

function publication(plan, value) {
  return reconcileSingleSiteRouteInventory({
    jobId: 'job-route-fixture',
    attemptId: 'attempt-route-fixture',
    coverageManifestDigest: `sha256:${'a'.repeat(64)}`,
    plan,
    diagnostic: value,
  });
}

const noCatalogPlan = compileSingleSiteRouteInventoryPlan({ pluginRegistry: registry(), coverageManifest });
assert.equal(noCatalogPlan.required, true);
assert.equal(noCatalogPlan.reviewedRoutes.length, 0, 'A missing reviewed catalog remains explicit rather than invented.');
assert(verifySingleSiteRouteInventoryPlan(noCatalogPlan));

const manifestOnly = publication(noCatalogPlan, diagnostic([
  route('/manifest-only', 'deployment-manifest'),
]));
assert.equal(manifestOnly.genericExecutions.length, 1);
assert.equal(manifestOnly.coverageGaps.length, 1, 'A generic inspection never pretends to supply a Product Oracle.');
assert.deepEqual(manifestOnly.genericExecutions[0].sources, [{ source: 'deployment-manifest', from: null, depth: 0 }]);
assert(verifySingleSiteRouteInventoryPublication(manifestOnly, {
  jobId: 'job-route-fixture',
  attemptId: 'attempt-route-fixture',
  coverageManifestDigest: `sha256:${'a'.repeat(64)}`,
}));

const crawlOnly = publication(noCatalogPlan, diagnostic([
  route('/crawl-only', 'crawl', `${origin}/`),
]));
assert.equal(crawlOnly.genericExecutions.length, 1);
assert.deepEqual(crawlOnly.genericExecutions[0].sources, [{ source: 'crawl', from: `${origin}/`, depth: 1 }]);

const exhausted = publication(noCatalogPlan, diagnostic([
  route('/bounded', 'crawl', `${origin}/`),
], {
  exhausted: true,
  limitations: [{ code: 'not-browser-rendered', source: 'static-navigation', url: origin, detail: 'Only inert HTML was parsed.' }],
}));
assert(exhausted.limitations.some(({ code }) => code === 'bound-route-count'));
assert(exhausted.limitations.some(({ code }) => code === 'not-browser-rendered'));

const reviewedPlan = compileSingleSiteRouteInventoryPlan({ pluginRegistry: registry(['/required']), coverageManifest });
const missingReviewed = publication(reviewedPlan, diagnostic([]));
assert.equal(missingReviewed.reviewedFindings.length, 1);
assert.equal(missingReviewed.reviewedFindings[0].auditId, 'ENV-002');
assert.equal(missingReviewed.reviewedFindings[0].reviewedAuditId, 'PAGE-001');
assert.match(missingReviewed.reviewedFindings[0].title, /missing or unreachable/);

const sitemap404Route = {
  ...route('/sitemap-404', 'sitemap', `${origin}/sitemap.xml`),
  disposition: 'unreachable',
};
const sitemap404 = publication(noCatalogPlan, diagnostic([sitemap404Route], {
  deploymentManifest: { supplied: false, candidateCount: 0 },
  sitemapDocuments: [successfulSitemapDocument()],
  responses: [{ url: sitemap404Route.url, depth: 0, status: 404, contentType: 'text/html', bytes: 100 }],
  failures: [{ code: 'http-status', source: 'crawl', url: sitemap404Route.url, detail: 'HTTP 404.' }],
}));
assert.equal(sitemap404.genericExecutions.length, 0, 'A frozen 404 is reported directly instead of scheduling a misleading browser inspection.');
assert.equal(sitemap404.reviewedFindings.length, 1, 'An unreviewed sitemap route with a frozen 404 must not disappear.');
assert.equal(sitemap404.reviewedFindings[0].reviewedAuditId, null);
assert.match(sitemap404.reviewedFindings[0].title, /inventoried route is unreachable/i);
assert.match(sitemap404.reviewedFindings[0].detail, /HTTP 404/);
assert.match(sitemap404.reviewedFindings[0].detail, /sitemap/);
assert.equal(sitemap404.coverageGaps.length, 1, 'The route failure does not supply a route-specific Product Oracle.');
assert(verifySingleSiteRouteInventoryPublication(sitemap404));

const missingFailureGap = structuredClone(sitemap404);
missingFailureGap.coverageGaps = [];
const missingFailureGapBody = { ...missingFailureGap };
delete missingFailureGapBody.publicationDigest;
missingFailureGap.publicationDigest = canonicalSha256(missingFailureGapBody);
assert.equal(
  verifySingleSiteRouteInventoryPublication(missingFailureGap),
  false,
  'Recomputing the self-digest cannot remove the required Product Oracle gap from a failed unreviewed route.',
);

const manifestFetchFailureRoute = {
  ...route('/manifest-fetch-failure', 'deployment-manifest'),
  disposition: 'fetch-failed',
};
const manifestFetchFailure = publication(noCatalogPlan, diagnostic([manifestFetchFailureRoute], {
  responses: [],
  failures: [{ code: 'fetch-error', source: 'crawl', url: manifestFetchFailureRoute.url, detail: 'Connection reset.' }],
}));
assert.equal(manifestFetchFailure.genericExecutions.length, 0);
assert.equal(manifestFetchFailure.reviewedFindings.length, 1, 'An unreviewed manifest route with a fetch failure must not disappear.');
assert.match(manifestFetchFailure.reviewedFindings[0].detail, /Connection reset/);
assert.match(manifestFetchFailure.reviewedFindings[0].detail, /deployment-manifest/);
assert.equal(manifestFetchFailure.coverageGaps.length, 1);
assert(verifySingleSiteRouteInventoryPublication(manifestFetchFailure));

const reviewedCatalogRoute = route('/required', 'catalog');
const emptyManifest = publication(reviewedPlan, diagnostic([reviewedCatalogRoute], {
  deploymentManifest: { supplied: true, candidateCount: 0 },
}));
assert.equal(emptyManifest.reviewedFindings.length, 1, 'A supplied empty deployment manifest is available declaration evidence.');
assert.match(emptyManifest.reviewedFindings[0].title, /absent from deployment declarations/);

const partialManifestPlan = compileSingleSiteRouteInventoryPlan({ pluginRegistry: registry(['/declared', '/required']), coverageManifest });
const partialManifest = publication(partialManifestPlan, diagnostic([
  route('/declared', 'deployment-manifest'),
  reviewedCatalogRoute,
], {
  deploymentManifest: { supplied: true, candidateCount: 1 },
}));
assert.deepEqual(partialManifest.reviewedFindings.map(({ route }) => route), ['/required']);

const emptySitemap = publication(reviewedPlan, diagnostic([reviewedCatalogRoute], {
  deploymentManifest: { supplied: false, candidateCount: 0 },
  sitemapDocuments: [successfulSitemapDocument()],
}));
assert.equal(emptySitemap.reviewedFindings.length, 1, 'A successful empty sitemap is available declaration evidence.');
assert.match(emptySitemap.reviewedFindings[0].detail, /sitemap/);

const partialSitemap = publication(partialManifestPlan, diagnostic([
  route('/declared', 'sitemap', `${origin}/sitemap.xml`),
  reviewedCatalogRoute,
], {
  deploymentManifest: { supplied: false, candidateCount: 0 },
  sitemapDocuments: [successfulSitemapDocument()],
}));
assert.deepEqual(partialSitemap.reviewedFindings.map(({ route }) => route), ['/required']);

const unavailableDeclarations = publication(reviewedPlan, diagnostic([reviewedCatalogRoute], {
  deploymentManifest: { supplied: false, candidateCount: 0 },
  sitemapDocuments: [{ ...successfulSitemapDocument(), statusCode: 503 }],
  limitations: [
    { code: 'source-unavailable', source: 'deployment-manifest', url: null, detail: 'No manifest was supplied.' },
    { code: 'source-unavailable', source: 'sitemap', url: null, detail: 'Sitemap fetch failed.' },
  ],
}));
assert.equal(unavailableDeclarations.reviewedFindings.length, 0, 'Unavailable declaration sources must remain limitations, not negative evidence.');
assert.equal(unavailableDeclarations.limitations.filter(({ code }) => code === 'source-unavailable').length, 2);

const tampered = structuredClone(manifestOnly);
tampered.genericExecutions[0].sources = [];
assert.equal(verifySingleSiteRouteInventoryPublication(tampered), false, 'Source contribution tampering invalidates publication digest.');

const targetedWithoutRoutes = compileSingleSiteRouteInventoryPlan({
  pluginRegistry: registry(['/required']),
  coverageManifest: {
    ...coverageManifest,
    scope: { qualifier: 'TARGETED' },
    selectedDefinitions: [{ auditId: 'NAV-001', area: 'navigation' }],
  },
});
assert.equal(targetedWithoutRoutes.required, false);
assert.equal(targetedWithoutRoutes.canonicalTargetId, null);

process.stdout.write('Single-site route integration self-test passed: failed unreviewed routes, declaration evidence, source limitations, generic coverage, reviewed Findings, and targeted omission are explicit.\n');
