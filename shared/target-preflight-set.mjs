import { canonicalDigest } from './canonical-contract.mjs';
import { preflightQuitting7ohSite } from './site-preflight.mjs';

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function targetPreflightInputsForRunContract(contract) {
  if (!record(contract)) throw new TypeError('Target preflight run contract is required.');
  if (contract.mode === 'single-site') {
    return Object.freeze([Object.freeze({
      url: contract.url,
      deploymentRole: contract.deploymentRole,
      certificatePolicy: contract.certificatePolicy,
    })]);
  }
  if (contract.mode === 'comparative') {
    return Object.freeze([
      Object.freeze({ url: contract.candidateUrl, deploymentRole: 'preview', certificatePolicy: 'strict' }),
      Object.freeze({ url: contract.productionUrl, deploymentRole: 'production', certificatePolicy: 'strict' }),
    ]);
  }
  throw new TypeError('Target preflight run contract mode is unsupported.');
}

export function targetPreflightInputsForSubject({
  mode, targets, certificatePolicy = 'strict', singleSiteDeploymentRole = null,
} = {}) {
  if (!['single-site', 'comparative'].includes(mode) || !Array.isArray(targets) || targets.length === 0) {
    throw new TypeError('Final subject mode and targets are required for target reprobe.');
  }
  return Object.freeze(targets.map(({ origin, role }) => Object.freeze({
    url: origin,
    deploymentRole: mode === 'single-site' ? singleSiteDeploymentRole : (role === 'production' ? 'production' : 'preview'),
    certificatePolicy: mode === 'single-site' ? certificatePolicy : 'strict',
  })).sort((left, right) => String(left.deploymentRole).localeCompare(String(right.deploymentRole))
    || left.url.localeCompare(right.url)));
}

export function deriveTargetPreflightSetIdentity(preflights) {
  if (!Array.isArray(preflights) || preflights.length === 0) {
    throw new TypeError('At least one target preflight is required.');
  }
  const rows = preflights.map((result) => {
    if (!record(result) || !result.accepted || !result.preflightDigest
      || !result.identityFingerprint || !result.deploymentRevision?.fingerprint) {
      const error = new Error(result?.issues?.[0]?.message ?? 'Target preflight was rejected or lacked authoritative identity.');
      error.code = 'TARGET_PREFLIGHT_REJECTED';
      throw error;
    }
    return {
      origin: result.origin,
      role: result.deploymentRole,
      identityFingerprint: result.identityFingerprint,
      deploymentRevision: result.deploymentRevision.fingerprint,
      preflightDigest: result.preflightDigest,
    };
  }).sort((left, right) => left.role.localeCompare(right.role) || left.origin.localeCompare(right.origin));
  return Object.freeze({ kind: 'target-preflight-set', value: canonicalDigest(rows) });
}

export async function probeTargetPreflightSet(inputs, {
  preflight = preflightQuitting7ohSite,
  preflightOptions = {},
} = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0 || typeof preflight !== 'function') {
    throw new TypeError('Target preflight inputs and probe function are required.');
  }
  const preflights = await Promise.all(inputs.map((input) => preflight(input, preflightOptions)));
  return Object.freeze({ preflights: Object.freeze(preflights), identity: deriveTargetPreflightSetIdentity(preflights) });
}
