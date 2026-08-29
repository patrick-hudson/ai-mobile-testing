import { canonicalDigest, exactKeys } from '../../shared/canonical-contract.mjs';
import { parseAuditedCandidateDeployment, parseReleaseArtifactManifest } from '../../shared/release-artifact-contract.mjs';
import { parseFinalReleaseSubject, parseReleaseSubjectCore } from '../../shared/release-subject.mjs';
import { verifyReleaseArtifactManifest } from './release-artifact.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RUN_ID = /^run-[a-f0-9]{32}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CLAIM_TOKEN = /^amtp\.[a-f0-9]{32}\.[A-Za-z0-9_-]{32,}$/u;

export class ExactPromotionError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExactPromotionError';
    this.code = code;
  }
}

function fail(code, message, cause) { throw new ExactPromotionError(code, message, cause); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function parseCiResult(value) {
  if (!record(value)) fail('EXACT_PROMOTION_CI_RESULT_INVALID', 'Shared release CI result is required.');
  exactKeys(value, [
    'schemaVersion', 'kind', 'stage', 'confirmed', 'requestId', 'operationId', 'runId', 'publicationDigest',
    'subjectDigest', 'executionSetDigest', 'subjectCore', 'finalSubject', 'decision', 'assertionExpected',
  ], 'Shared release CI result');
  if (value.schemaVersion !== 1 || value.kind !== 'shared-release-ci-result' || value.stage !== 'final'
    || value.confirmed !== true
    || !REQUEST_ID.test(value.requestId ?? '') || !/^[a-f0-9]{64}$/u.test(value.operationId ?? '')
    || !RUN_ID.test(value.runId ?? '') || !DIGEST.test(value.publicationDigest ?? '')) {
    fail('EXACT_PROMOTION_CI_RESULT_INVALID', 'Shared release CI result identity is invalid.');
  }
  const subjectCore = parseReleaseSubjectCore(value.subjectCore);
  const subject = parseFinalReleaseSubject(value.finalSubject);
  exactKeys(value.decision, ['code', 'ready', 'authority', 'runRevision', 'decisionRevision'], 'Shared release CI decision');
  exactKeys(value.assertionExpected, [
    'subjectDigest', 'authority', 'executionSetDigest', 'runRevision', 'decisionRevision',
  ], 'Shared release CI assertion expectation');
  if (subject.subjectCoreDigest !== subjectCore.digest
    || value.subjectDigest !== subject.digest || value.executionSetDigest !== subject.executionManifestDigest
    || value.decision.ready !== true || !['RELEASE_READY', 'FEATURE_READY'].includes(value.decision.code)
    || value.decision.authority !== subject.grantedAuthority.qualifier
    || value.assertionExpected.subjectDigest !== subject.digest
    || value.assertionExpected.authority !== value.decision.authority
    || value.assertionExpected.executionSetDigest !== subject.executionManifestDigest
    || value.assertionExpected.runRevision !== value.decision.runRevision
    || value.assertionExpected.decisionRevision !== value.decision.decisionRevision
    || !Number.isSafeInteger(value.decision.runRevision) || value.decision.runRevision < 1
    || !Number.isSafeInteger(value.decision.decisionRevision) || value.decision.decisionRevision < 1) {
    fail('EXACT_PROMOTION_CI_RESULT_INVALID', 'Shared release CI result is internally inconsistent or not ready.');
  }
  if (subjectCore.certificatePolicy !== 'strict') {
    fail('EXACT_PROMOTION_EVIDENCE_NON_AUTHORITATIVE', 'Exact promotion requires authoritative strict-certificate evidence.');
  }
  return { document: structuredClone(value), subject };
}

function parseProduction(value) {
  if (!record(value)) throw new TypeError('Production provider configuration is required.');
  exactKeys(value, ['accountId', 'projectName', 'branch'], 'Production provider configuration');
  return Object.freeze({
    accountId: safeId(value.accountId, 'production.accountId'),
    projectName: safeId(value.projectName, 'production.projectName'),
    branch: safeId(value.branch, 'production.branch'),
  });
}

function validateDependencies(client, provider) {
  if (!record(client) || typeof client.assertRelease !== 'function' || typeof client.consumePromotion !== 'function') {
    throw new TypeError('Exact promotion client must implement assertRelease and consumePromotion.');
  }
  if (!record(provider) || typeof provider.prepare !== 'function' || typeof provider.deploy !== 'function') {
    throw new TypeError('Exact promotion provider must implement prepare and deploy.');
  }
}

function auditedTarget(subject) {
  const role = subject.mode === 'comparative' ? 'candidate' : null;
  const candidates = subject.targets.filter((target) => role ? target.role === role : target.role !== 'production');
  if (candidates.length !== 1) fail('EXACT_PROMOTION_SUBJECT_INVALID', 'Release subject does not identify exactly one audited candidate origin.');
  return candidates[0];
}

function validateClaim(claim, ci) {
  if (!record(claim) || !CLAIM_TOKEN.test(claim.token ?? '') || claim.runId !== ci.document.runId
    || claim.subjectDigest !== ci.document.subjectDigest || claim.authority !== ci.document.decision.authority
    || claim.runRevision !== ci.document.decision.runRevision
    || claim.decisionRevision !== ci.document.decision.decisionRevision
    || !Number.isFinite(Date.parse(claim.expiresAt))) {
    fail('EXACT_PROMOTION_CLAIM_INVALID', 'Promotion assertion returned an invalid or mismatched claim.');
  }
  return claim;
}

function validateConsumption(receipt, ci) {
  if (!record(receipt) || receipt.consumed !== true || !/^[a-f0-9]{32}$/u.test(receipt.claimId ?? '')
    || receipt.runId !== ci.document.runId || receipt.subjectDigest !== ci.document.subjectDigest
    || receipt.publicationDigest !== ci.document.publicationDigest || !DIGEST.test(receipt.receiptDigest ?? '')
    || !Number.isFinite(Date.parse(receipt.consumedAt))) {
    fail('EXACT_PROMOTION_CONSUMPTION_INVALID', 'Promotion consumption receipt is invalid or mismatched.');
  }
  return receipt;
}

export async function executeExactPromotion({
  ciResult, artifactRoot, artifactManifest, candidateDeployment, projectId, production,
  sourceRevision, requestId, client, provider, assertionTtlMs = 60_000,
} = {}) {
  validateDependencies(client, provider);
  const ci = parseCiResult(ciResult);
  const manifest = parseReleaseArtifactManifest(artifactManifest);
  const candidate = parseAuditedCandidateDeployment(candidateDeployment);
  const destination = parseProduction(production);
  safeId(projectId, 'projectId');
  if (!REQUEST_ID.test(requestId ?? '')) throw new TypeError('Exact promotion requestId is invalid.');
  if (typeof sourceRevision !== 'string' || !sourceRevision || sourceRevision.length > 256) {
    throw new TypeError('Exact promotion sourceRevision is invalid.');
  }
  if (!Number.isSafeInteger(assertionTtlMs) || assertionTtlMs < 1 || assertionTtlMs > 5 * 60_000) {
    throw new TypeError('Exact promotion assertionTtlMs is outside bounds.');
  }
  const target = auditedTarget(ci.subject);
  if (candidate.auditedOrigin !== target.origin) {
    fail('EXACT_PROMOTION_CANDIDATE_MISMATCH', 'Audited candidate deployment origin does not match the immutable release subject.');
  }
  if (candidate.artifactManifestDigest !== manifest.digest) {
    fail('EXACT_PROMOTION_ARTIFACT_MISMATCH', 'Audited candidate deployment is bound to different release bytes.');
  }
  if (candidate.sourceRevision !== sourceRevision) {
    fail('EXACT_PROMOTION_SOURCE_MISMATCH', 'Audited candidate deployment source revision does not match delivery intent.');
  }

  await verifyReleaseArtifactManifest(artifactRoot, manifest);
  const providerInput = Object.freeze({
    artifactRoot,
    artifactManifest: manifest,
    candidateDeployment: candidate,
    production: destination,
    sourceRevision,
    requestId,
    subjectDigest: ci.document.subjectDigest,
    publicationDigest: ci.document.publicationDigest,
  });
  await provider.prepare(providerInput);
  await verifyReleaseArtifactManifest(artifactRoot, manifest);

  const assertionRequestId = `${requestId}:assert`;
  const consumeRequestId = `${requestId}:consume`;
  const claim = validateClaim(await client.assertRelease({
    runId: ci.document.runId,
    projectId,
    expected: { projectId, ...ci.document.assertionExpected },
    ttlMs: assertionTtlMs,
    requestId: assertionRequestId,
  }), ci);
  await verifyReleaseArtifactManifest(artifactRoot, manifest);
  const consumption = validateConsumption(await client.consumePromotion({
    runId: ci.document.runId,
    token: claim.token,
    expectedSubjectDigest: ci.document.subjectDigest,
    requestId: consumeRequestId,
  }), ci);
  const providerReceipt = await provider.deploy(providerInput);
  if (!record(providerReceipt) || providerReceipt.schemaVersion !== 1 || providerReceipt.provider !== candidate.provider
    || typeof providerReceipt.deploymentId !== 'string' || !providerReceipt.deploymentId
    || typeof providerReceipt.deploymentUrl !== 'string') {
    fail('EXACT_PROMOTION_PROVIDER_RECEIPT_INVALID', 'Provider returned an invalid production deployment receipt.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'exact-promotion-receipt',
    requestId,
    runId: ci.document.runId,
    subjectDigest: ci.document.subjectDigest,
    publicationDigest: ci.document.publicationDigest,
    artifactManifestDigest: manifest.digest,
    candidateDeploymentDigest: candidate.digest,
    claimReceiptDigest: consumption.receiptDigest,
    claimConsumedAt: consumption.consumedAt,
    production: destination,
    provider: structuredClone(providerReceipt),
  };
  return Object.freeze({ ...body, digest: canonicalDigest(body) });
}
