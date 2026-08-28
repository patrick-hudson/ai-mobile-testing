import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SingleSiteLaunchError,
  createSingleSiteLaunchCoordinator,
} from '../portal/single-site-launch.mjs';

const pluginRegistry = JSON.parse(await readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8'));
const targetRegistry = JSON.parse(await readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8'));
const url = 'https://beta.quitting7oh-org.pages.dev';
let revision = 'revision-a';
let identityAccepted = true;
let jobCreates = 0;

function contract(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: 'single-site',
    url,
    deploymentRole: 'preview',
    certificatePolicy: 'strict',
    targetIds: ['single-site-mobile-chromium'],
    scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['HOME-001'], areas: [] },
    ...overrides,
  };
}

async function fakePreflight(input) {
  const accepted = identityAccepted;
  return {
    schemaVersion: 1,
    accepted,
    checkedAt: '2026-08-25T12:00:00.000Z',
    origin: input.url,
    deploymentRole: input.deploymentRole,
    certificatePolicy: input.certificatePolicy,
    identityFingerprint: accepted ? 'identity-a' : null,
    deploymentRevision: accepted
      ? { status: 'verified', fingerprint: revision, source: 'explicit-build-id', signals: [], limitation: null }
      : { status: 'unavailable', fingerprint: null, source: null, signals: [], limitation: 'identity-rejected' },
    evidenceAuthority: accepted
      ? { status: 'authoritative', reasons: [] }
      : { status: 'non-authoritative', reasons: ['preflight-rejected'] },
    markers: [],
    probes: [],
    issues: accepted ? [] : [{ code: 'PREFLIGHT_IDENTITY_MARKER_MISSING', focusTarget: 'url' }],
    preflightDigest: accepted ? `preflight-${revision}` : null,
  };
}

const coordinator = createSingleSiteLaunchCoordinator({
  pluginRegistry,
  targetRegistry,
  runnerRevision: 'runner:self-test',
  preflight: fakePreflight,
  validateContract(value) {
    assert(value.targetIds.every((id) => targetRegistry.singleSiteTargets.some((target) => target.id === id)));
  },
  async createJob(input) {
    jobCreates += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { id: `job-${jobCreates}`, manifestDigest: input.coverage.manifestDigest };
  },
});

const preview = await coordinator.preview(contract());
assert.equal(preview.accepted, true);
assert.equal(preview.coverage.scope.qualifier, 'TARGETED');
assert.match(preview.previewDigest, /^sha256:[a-f0-9]{64}$/);
assert.equal(preview.coverage.deployment.revision.value, revision);
assert.equal(preview.routeInventoryPlan.required, false, 'Targeted scope without ENV-002 intentionally omits discovery.');
assert.equal(preview.routeInventoryPlan.coverageManifestDigest, preview.coverage.manifestDigest);

const routePreview = await coordinator.preview(contract({
  scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['ENV-002'], areas: [] },
  targetIds: ['single-site-desktop-chromium'],
}));
assert.equal(routePreview.routeInventoryPlan.required, true);
assert.equal(routePreview.routeInventoryPlan.canonicalTargetId, 'single-site-desktop-chromium');
assert(routePreview.routeInventoryPlan.reviewedRoutes.length > 0, 'Route coverage freezes the generated reviewed route catalog.');

const launchRequest = {
  runContract: contract(),
  previewDigest: preview.previewDigest,
  idempotencyKey: 'launch-self-test-0001',
  advisory: { schemaVersion: 1, aiReview: { optedIn: true, model: 'claude-test-model' } },
};
const [first, duplicate] = await Promise.all([
  coordinator.launch(launchRequest),
  coordinator.launch(launchRequest),
]);
assert.equal(first.launched, true);
assert.equal(duplicate.launched, true);
assert.equal([first.idempotent, duplicate.idempotent].filter(Boolean).length, 1);
assert.equal(first.job.id, duplicate.job.id);
assert.equal(jobCreates, 1, 'Concurrent identical launch requests must create exactly one durable job.');

await assert.rejects(
  coordinator.launch({
    ...launchRequest,
    idempotencyKey: 'launch-self-test-invalid-advisory',
    advisory: { schemaVersion: 1, aiReview: { optedIn: false, model: 'must-be-null' } },
  }),
  (error) => error instanceof SingleSiteLaunchError && error.code === 'SINGLE_SITE_ADVISORY_INVALID',
);

await assert.rejects(
  coordinator.launch({
    ...launchRequest,
    advisory: { schemaVersion: 1, aiReview: { optedIn: false, model: null } },
  }),
  (error) => error instanceof SingleSiteLaunchError && error.code === 'SINGLE_SITE_IDEMPOTENCY_CONFLICT',
);

await assert.rejects(
  coordinator.launch({ ...launchRequest, runContract: contract({ targetIds: ['single-site-desktop-chromium'] }) }),
  (error) => error instanceof SingleSiteLaunchError && error.code === 'SINGLE_SITE_IDEMPOTENCY_CONFLICT',
);

const stalePreview = await coordinator.preview(contract());
revision = 'revision-b';
const stale = await coordinator.launch({
  runContract: contract(),
  previewDigest: stalePreview.previewDigest,
  idempotencyKey: 'launch-self-test-0002',
});
assert.equal(stale.launched, false);
assert.equal(stale.reason, 'preview-stale');
assert.notEqual(stale.refreshedPreview.previewDigest, stalePreview.previewDigest);
assert.equal(jobCreates, 1, 'A stale preview must not create a run or job.');

identityAccepted = false;
const rejected = await coordinator.preview(contract());
assert.equal(rejected.accepted, false);
assert.equal(rejected.coverage, null);
assert.equal(rejected.previewDigest, null);
assert.equal(jobCreates, 1, 'Side-effect-free preview must not create a run or job.');

process.stdout.write('Single-site launch self-test passed: preview is side-effect free, stale revisions create no job, and idempotent launch creates exactly one job.\n');
