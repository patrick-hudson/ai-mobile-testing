import { canonicalSha256, compileDefinitionCoverageManifest } from '../shared/run-compiler.mjs';
import { parseRunContract } from '../shared/run-contract.mjs';
import { parseSingleSiteAdvisory } from '../shared/single-site-advisory.mjs';
import { compileSingleSiteRouteInventoryPlan } from '../shared/single-site-route-plan.mjs';

export const SINGLE_SITE_LAUNCH_SCHEMA_VERSION = 1;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class SingleSiteLaunchError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = 'SingleSiteLaunchError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function parsedSingleSiteContract(value) {
  let contract;
  try {
    contract = parseRunContract(value);
  } catch (error) {
    throw new SingleSiteLaunchError(
      400,
      'SINGLE_SITE_CONTRACT_INVALID',
      error instanceof Error ? error.message : String(error),
      { focusTarget: 'runContract' },
    );
  }
  if (contract.mode !== 'single-site') {
    throw new SingleSiteLaunchError(
      400,
      'SINGLE_SITE_MODE_REQUIRED',
      'This endpoint accepts only Single-site Audit contracts.',
      { focusTarget: 'mode' },
    );
  }
  return contract;
}

function validatePreflightResult(result, contract) {
  if (!result || typeof result !== 'object' || result.schemaVersion !== 1
    || typeof result.accepted !== 'boolean' || result.origin !== contract.url
    || result.deploymentRole !== contract.deploymentRole) {
    throw new SingleSiteLaunchError(
      502,
      'SINGLE_SITE_PREFLIGHT_INVALID',
      'Deployment preflight returned an invalid or mismatched result.',
    );
  }
  return result;
}

function compilerPreflightBinding(result, contract) {
  if (!result.accepted || typeof result.identityFingerprint !== 'string'
    || !result.identityFingerprint || !result.deploymentRevision
    || !result.evidenceAuthority) {
    throw new SingleSiteLaunchError(
      422,
      'SINGLE_SITE_PREFLIGHT_REJECTED',
      'Deployment preflight did not establish a compilable quitting7oh identity.',
      { preflight: result },
    );
  }
  const revisionIdentified = result.deploymentRevision.status === 'verified'
    && typeof result.deploymentRevision.fingerprint === 'string'
    && result.deploymentRevision.fingerprint.length > 0;
  return {
    schemaVersion: 1,
    url: contract.url,
    deploymentRole: contract.deploymentRole,
    identityFingerprint: result.identityFingerprint,
    deploymentRevision: revisionIdentified
      ? { status: 'identified', value: result.deploymentRevision.fingerprint }
      : { status: 'unavailable', value: null },
    evidenceAuthority: {
      status: result.evidenceAuthority.status,
      reasons: [...result.evidenceAuthority.reasons],
    },
  };
}

function previewDigestBody(contract, preflight, coverage, routeInventoryPlan) {
  return {
    schemaVersion: SINGLE_SITE_LAUNCH_SCHEMA_VERSION,
    mode: 'single-site',
    runContract: contract,
    preflightDigest: preflight.preflightDigest,
    identityFingerprint: preflight.identityFingerprint,
    deploymentRevisionFingerprint: preflight.deploymentRevision?.fingerprint ?? null,
    evidenceAuthority: preflight.evidenceAuthority,
    coverageManifestDigest: coverage.manifestDigest,
    routeInventoryPlanDigest: routeInventoryPlan.planDigest,
    registryRevisions: coverage.revisions,
  };
}

function rejectedPreview(contract, preflight) {
  return Object.freeze({
    schemaVersion: SINGLE_SITE_LAUNCH_SCHEMA_VERSION,
    mode: 'single-site',
    accepted: false,
    runContract: contract,
    preflight,
    coverage: null,
    previewDigest: null,
  });
}

export function createSingleSiteLaunchCoordinator({
  pluginRegistry,
  targetRegistry,
  runnerRevision,
  preflight,
  validateContract = () => {},
  createJob,
  legacyAuthorityFence = null,
}) {
  if (!pluginRegistry || !targetRegistry || typeof runnerRevision !== 'string' || !runnerRevision.trim()) {
    throw new TypeError('Single-site launch requires immutable plugin, target, and runner revisions.');
  }
  if (typeof preflight !== 'function') throw new TypeError('Single-site launch requires a preflight function.');
  if (createJob !== undefined && typeof createJob !== 'function') {
    throw new TypeError('createJob must be a function when launch is enabled.');
  }

  const launches = new Map();

  async function preview(input) {
    const contract = parsedSingleSiteContract(input);
    await validateContract(contract);
    const preflightResult = validatePreflightResult(await preflight({
      url: contract.url,
      deploymentRole: contract.deploymentRole,
      certificatePolicy: contract.certificatePolicy,
    }), contract);
    if (!preflightResult.accepted) return rejectedPreview(contract, preflightResult);

    let coverage;
    try {
      coverage = compileDefinitionCoverageManifest({
        runContract: contract,
        pluginRegistry,
        targetRegistry,
        preflightBinding: compilerPreflightBinding(preflightResult, contract),
        runnerRevision,
      });
    } catch (error) {
      throw new SingleSiteLaunchError(
        422,
        'SINGLE_SITE_SCOPE_NOT_EXECUTABLE',
        error instanceof Error ? error.message : String(error),
        { focusTarget: 'scope' },
      );
    }
    const routeInventoryPlan = compileSingleSiteRouteInventoryPlan({ pluginRegistry, coverageManifest: coverage });
    return Object.freeze({
      schemaVersion: SINGLE_SITE_LAUNCH_SCHEMA_VERSION,
      mode: 'single-site',
      accepted: true,
      runContract: contract,
      preflight: preflightResult,
      coverage,
      routeInventoryPlan,
      previewDigest: canonicalSha256(previewDigestBody(contract, preflightResult, coverage, routeInventoryPlan)),
    });
  }

  async function launch(request) {
    if (!createJob) {
      throw new SingleSiteLaunchError(503, 'SINGLE_SITE_QUEUE_UNAVAILABLE', 'The Single-site worker queue is not configured.');
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new SingleSiteLaunchError(400, 'SINGLE_SITE_LAUNCH_INVALID', 'Launch request must be an object.');
    }
    const idempotencyKey = request.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new SingleSiteLaunchError(
        400,
        'SINGLE_SITE_IDEMPOTENCY_KEY_INVALID',
        'idempotencyKey must be 16-128 safe characters.',
      );
    }
    if (typeof request.previewDigest !== 'string' || !DIGEST.test(request.previewDigest)) {
      throw new SingleSiteLaunchError(
        400,
        'SINGLE_SITE_PREVIEW_DIGEST_INVALID',
        'Launch requires the exact previewDigest returned by preflight.',
      );
    }
    const contract = parsedSingleSiteContract(request.runContract);
    let advisory;
    try {
      advisory = parseSingleSiteAdvisory(request.advisory);
    } catch (error) {
      throw new SingleSiteLaunchError(
        400,
        'SINGLE_SITE_ADVISORY_INVALID',
        error instanceof Error ? error.message : String(error),
        { focusTarget: 'aiReview' },
      );
    }
    const requestDigest = canonicalSha256({
      runContract: contract,
      previewDigest: request.previewDigest,
      advisory,
    });
    const existing = launches.get(idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new SingleSiteLaunchError(
          409,
          'SINGLE_SITE_IDEMPOTENCY_CONFLICT',
          'This idempotency key is already bound to different launch inputs.',
        );
      }
      const result = await existing.promise;
      return Object.freeze({ ...result, idempotent: true });
    }

    const launchPromise = (async () => {
      const refreshedPreview = await preview(contract);
      if (!refreshedPreview.accepted) {
        return Object.freeze({
          schemaVersion: SINGLE_SITE_LAUNCH_SCHEMA_VERSION,
          launched: false,
          reason: 'preflight-rejected',
          refreshedPreview,
          idempotent: false,
        });
      }
      if (refreshedPreview.previewDigest !== request.previewDigest) {
        return Object.freeze({
          schemaVersion: SINGLE_SITE_LAUNCH_SCHEMA_VERSION,
          launched: false,
          reason: 'preview-stale',
          refreshedPreview,
          idempotent: false,
        });
      }
      const create = () => createJob({
        idempotencyKey,
        requestDigest,
        runContract: refreshedPreview.runContract,
        preflight: refreshedPreview.preflight,
        coverage: refreshedPreview.coverage,
        routeInventoryPlan: refreshedPreview.routeInventoryPlan,
        previewDigest: refreshedPreview.previewDigest,
        advisory,
      });
      const job = legacyAuthorityFence
        ? await legacyAuthorityFence.withAuthority('single-site-launch', create)
        : await create();
      return Object.freeze({
        schemaVersion: SINGLE_SITE_LAUNCH_SCHEMA_VERSION,
        launched: true,
        reason: null,
        previewDigest: refreshedPreview.previewDigest,
        job,
        idempotent: false,
      });
    })();
    launches.set(idempotencyKey, { requestDigest, promise: launchPromise });
    try {
      return await launchPromise;
    } catch (error) {
      launches.delete(idempotencyKey);
      throw error;
    }
  }

  return Object.freeze({ preview, launch });
}
