import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalDigest } from '../../shared/canonical-contract.mjs';
import { assertPrincipalAuthorized, CONTROL_ACTIONS, ControlPlaneError } from '../../shared/control-plane-contract.mjs';
import { atomicWriteFile, atomicWriteJson } from './atomic-filesystem.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const PROMOTION_CLAIM_SCHEMA_VERSION = 2;
function fail(code, message, statusCode = 409) { throw new ControlPlaneError(code, message, statusCode); }
function match(value, expected) {
  const left = Buffer.from(String(value)); const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function openPromotionClaimStore({ root, clock = () => Date.now() } = {}) {
  if (!root) fail('PROMOTION_CLAIM_INVALID', 'Promotion claim root is required.', 400);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('PROMOTION_CLAIM_INVALID', 'Promotion claim root must be a real directory.', 500);
  await fs.chmod(root, 0o700);
  const secretPath = path.join(root, 'claim-master.key');
  const storage = { root: path.resolve(root), fs, nonce: () => randomBytes(12).toString('hex') };
  let master;
  try { master = await fs.readFile(secretPath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    master = randomBytes(32);
    try {
      await atomicWriteFile(storage, secretPath, master, { mode: 0o600, exclusive: true });
    } catch (writeError) {
      if (writeError?.code !== 'ATOMIC_ALREADY_EXISTS') throw writeError;
      master = await fs.readFile(secretPath);
    }
  }
  if (master.length !== 32) fail('PROMOTION_CLAIM_CORRUPT', 'Promotion claim master key is invalid.', 500);
  return Object.freeze({ root: path.resolve(root), clock, master, storage });
}

function parseStoredClaim(value, expectedId) {
  const { digest, ...body } = value ?? {};
  if (value?.schemaVersion !== PROMOTION_CLAIM_SCHEMA_VERSION || value.kind !== 'promotion-claim' || value.id !== expectedId
    || !DIGEST.test(value.selectorDigest)
    || !Number.isSafeInteger(value.selectorRevision) || value.selectorRevision < 1
    || typeof value.activeBuildIdentity !== 'string' || !value.activeBuildIdentity
    || digest !== canonicalDigest(body)) fail('PROMOTION_CLAIM_CORRUPT', 'Promotion claim record is corrupt.', 500);
  return value;
}

function parseStoredReceipt(value, claim) {
  const { digest, ...body } = value ?? {};
  if (value?.schemaVersion !== 1 || value.kind !== 'promotion-consumption-receipt'
    || value.claimId !== claim.id || value.principalId !== claim.principalId
    || value.runId !== claim.runId || value.subjectDigest !== claim.subjectDigest
    || value.publicationDigest !== claim.publicationDigest
    || typeof value.requestId !== 'string' || value.requestId.length < 8 || value.requestId.length > 256
    || !Number.isFinite(Date.parse(value.consumedAt)) || digest !== canonicalDigest(body)) {
    fail('PROMOTION_CLAIM_CORRUPT', 'Promotion consumption receipt is corrupt.', 500);
  }
  return value;
}

function consumptionResult(receipt) {
  return Object.freeze({
    consumed: true,
    claimId: receipt.claimId,
    runId: receipt.runId,
    subjectDigest: receipt.subjectDigest,
    publicationDigest: receipt.publicationDigest,
    consumedAt: receipt.consumedAt,
    receiptDigest: receipt.digest,
  });
}

function validateAuthorityContext(value) {
  const selector = value?.selector;
  const binding = value?.binding;
  const { digest: selectorDigest, ...selectorBody } = selector ?? {};
  const { digest: bindingDigest, ...bindingBody } = binding ?? {};
  if (selector?.phase !== 'ACTIVE' || selector.activationEpoch !== 1
    || !DIGEST.test(selectorDigest) || selectorDigest !== canonicalDigest(selectorBody)
    || !Number.isSafeInteger(selector.revision) || selector.revision < 1
    || typeof selector.activeBuildIdentity !== 'string' || !selector.activeBuildIdentity
    || !DIGEST.test(binding?.storeMarkerDigest)
    || !Number.isSafeInteger(binding?.storeGeneration) || binding.storeGeneration < 1
    || binding.activationEpoch !== selector.activationEpoch
    || typeof binding.writerProtocol !== 'string' || !binding.writerProtocol
    || bindingDigest !== canonicalDigest(bindingBody)) {
    fail('PROMOTION_AUTHORITY_INACTIVE', 'Promotion requires the current ACTIVE durable store binding.');
  }
  return Object.freeze({
    storeMarkerDigest: binding.storeMarkerDigest,
    storeGeneration: binding.storeGeneration,
    activationEpoch: binding.activationEpoch,
    writerProtocol: binding.writerProtocol,
    selectorDigest,
    selectorRevision: selector.revision,
    activeBuildIdentity: selector.activeBuildIdentity,
  });
}

function claimResult(claim, secret) {
  return Object.freeze({
    token: `amtp.${claim.id}.${secret}`, expiresAt: claim.expiresAt, runId: claim.runId,
    subjectDigest: claim.subjectDigest, authority: claim.authority, runRevision: claim.runRevision,
    decisionRevision: claim.decisionRevision,
    authorityBinding: {
      storeMarkerDigest: claim.storeMarkerDigest,
      storeGeneration: claim.storeGeneration,
      activationEpoch: claim.activationEpoch,
      writerProtocol: claim.writerProtocol,
      selectorDigest: claim.selectorDigest,
      selectorRevision: claim.selectorRevision,
      activeBuildIdentity: claim.activeBuildIdentity,
    },
  });
}

function assertIdempotentClaim(existing, intended, ttlMs) {
  for (const field of ['requestId', 'principalId', 'projectId', 'runId', 'subjectDigest', 'authority', 'executionSetDigest', 'runRevision', 'decisionRevision',
    'storeMarkerDigest', 'storeGeneration', 'activationEpoch', 'writerProtocol',
    'selectorDigest', 'selectorRevision', 'activeBuildIdentity']) {
    if (existing[field] !== intended[field]) fail('IDEMPOTENCY_CONFLICT', 'Promotion assertion request id was reused with different content.');
  }
  if (Date.parse(existing.expiresAt) - Date.parse(existing.issuedAt) !== ttlMs) {
    fail('IDEMPOTENCY_CONFLICT', 'Promotion assertion request id was reused with a different lifetime.');
  }
}

function validateHead(publication, principal, expected) {
  assertPrincipalAuthorized(principal, CONTROL_ACTIONS.RELEASE_ASSERT, { projectId: expected?.projectId, runId: publication?.runId });
  const decision = publication?.decision;
  if (!decision || !publication || !DIGEST.test(publication.finalSubjectDigest)
    || !DIGEST.test(publication.digest) || !DIGEST.test(decision.executionManifestDigest)) {
    fail('PROMOTION_EMPTY_EVIDENCE', 'Current publication is missing or invalid.');
  }
  if (decision.ready !== true || !['RELEASE_READY', 'FEATURE_READY'].includes(decision.code)) {
    fail(decision?.code ?? 'PROMOTION_NOT_READY', 'Current release decision is not ready.');
  }
  if (decision.superseded === true) fail('PROMOTION_SUPERSEDED', 'Current release decision is superseded.');
  if (expected.subjectDigest !== publication.finalSubjectDigest) fail('PROMOTION_SUBJECT_MISMATCH', 'Promotion subject does not match current publication.');
  if (expected.authority !== decision.grantedAuthority) fail('PROMOTION_SCOPE_MISMATCH', 'Promotion authority does not match current publication.');
  if (expected.executionSetDigest !== decision.executionManifestDigest) fail('PROMOTION_EXECUTION_SET_MISMATCH', 'Promotion execution set does not match current publication.');
  if (expected.runRevision !== publication.runRevision || expected.decisionRevision !== publication.decisionRevision) {
    fail('PROMOTION_STALE_REVISION', 'Promotion expected revision is stale.');
  }
}

export async function issuePromotionClaim(store, { principal, publication, authorityContext, expected, ttlMs = 60_000, requestId = null }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 5 * 60_000) fail('PROMOTION_CLAIM_INVALID', 'Promotion claim TTL is outside bounds.', 400);
  if (requestId !== null && (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 256)) fail('IDEMPOTENCY_KEY_INVALID', 'Promotion assertion request id is invalid.', 400);
  const authorityBinding = validateAuthorityContext(authorityContext);
  if (typeof publication?.runId !== 'string' || !publication.runId) validateHead(publication, principal, expected);
  const effectiveRequestId = requestId ?? `direct-${randomBytes(16).toString('hex')}`;
  const id = createHash('sha256').update(`${principal.id}\0${publication.runId}\0${effectiveRequestId}`).digest('hex').slice(0, 32);
  const secret = createHmac('sha256', store.master).update(id).digest('base64url');
  const tokenHash = createHash('sha256').update(secret).digest('base64url');
  const intended = {
    requestId: effectiveRequestId, principalId: principal.id, projectId: expected?.projectId,
    runId: publication?.runId, subjectDigest: expected?.subjectDigest, authority: expected?.authority,
    executionSetDigest: expected?.executionSetDigest, publicationDigest: publication?.digest,
    runRevision: expected?.runRevision, decisionRevision: expected?.decisionRevision,
    storeMarkerDigest: authorityBinding.storeMarkerDigest, storeGeneration: authorityBinding.storeGeneration,
    activationEpoch: authorityBinding.activationEpoch, writerProtocol: authorityBinding.writerProtocol,
    selectorDigest: authorityBinding.selectorDigest, selectorRevision: authorityBinding.selectorRevision,
    activeBuildIdentity: authorityBinding.activeBuildIdentity,
  };
  const claimPath = path.join(store.root, `${id}.json`);
  const existing = await fs.readFile(claimPath, 'utf8').then(JSON.parse).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    const parsed = parseStoredClaim(existing, id);
    assertIdempotentClaim(parsed, intended, ttlMs);
    return claimResult(parsed, secret);
  }
  validateHead(publication, principal, expected);
  const body = {
    schemaVersion: PROMOTION_CLAIM_SCHEMA_VERSION, kind: 'promotion-claim', id, requestId: effectiveRequestId, principalId: principal.id, projectId: expected.projectId,
    runId: publication.runId, subjectDigest: publication.finalSubjectDigest,
    authority: publication.decision.grantedAuthority,
    executionSetDigest: publication.decision.executionManifestDigest,
    publicationDigest: publication.digest, runRevision: publication.runRevision,
    decisionRevision: publication.decisionRevision, issuedAt: new Date(store.clock()).toISOString(),
    storeMarkerDigest: authorityBinding.storeMarkerDigest, storeGeneration: authorityBinding.storeGeneration,
    activationEpoch: authorityBinding.activationEpoch, writerProtocol: authorityBinding.writerProtocol,
    selectorDigest: authorityBinding.selectorDigest, selectorRevision: authorityBinding.selectorRevision,
    activeBuildIdentity: authorityBinding.activeBuildIdentity,
    expiresAt: new Date(store.clock() + ttlMs).toISOString(), tokenHash, consumedAt: null,
    digest: null,
  };
  const { digest: _digest, ...digestBody } = body;
  body.digest = canonicalDigest(digestBody);
  try {
    await atomicWriteJson(store.storage, claimPath, body, { mode: 0o600, exclusive: true });
  } catch (error) {
    if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
    const raced = parseStoredClaim(JSON.parse(await fs.readFile(claimPath, 'utf8')), id);
    assertIdempotentClaim(raced, body, ttlMs);
    return claimResult(raced, secret);
  }
  return claimResult(body, secret);
}

export async function consumePromotionClaim(store, token, {
  principal, requestId, expectedSubjectDigest, withCurrentPublication = null,
}) {
  if (typeof withCurrentPublication !== 'function') {
    fail('PROMOTION_FENCE_REQUIRED', 'Promotion claim consumption requires the live publication and authority fence.', 500);
  }
  if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 256) {
    fail('IDEMPOTENCY_KEY_INVALID', 'Promotion consumption request id is invalid.', 400);
  }
  const parsed = /^amtp\.([a-f0-9]{32})\.([A-Za-z0-9_-]{32,})$/.exec(String(token));
  if (!parsed) fail('PROMOTION_CLAIM_INVALID', 'Promotion claim is invalid.', 401);
  return (async () => {
    let claim;
    try { claim = JSON.parse(await fs.readFile(path.join(store.root, `${parsed[1]}.json`), 'utf8')); } catch {
      fail('PROMOTION_CLAIM_INVALID', 'Promotion claim is invalid.', 401);
    }
    if (!match(createHash('sha256').update(parsed[2]).digest('base64url'), claim.tokenHash)) fail('PROMOTION_CLAIM_INVALID', 'Promotion claim is invalid.', 401);
    parseStoredClaim(claim, parsed[1]);
    if (claim.principalId !== principal?.id) fail('PROMOTION_CLAIM_PRINCIPAL_MISMATCH', 'Promotion claim belongs to another delivery principal.', 403);
    assertPrincipalAuthorized(principal, CONTROL_ACTIONS.PROMOTION_CONSUME, { projectId: claim.projectId, runId: claim.runId });
    const receiptPath = path.join(store.root, `${claim.id}.consumed.json`);
    const existingReceipt = await fs.readFile(receiptPath, 'utf8')
      .then((value) => parseStoredReceipt(JSON.parse(value), claim))
      .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (existingReceipt) {
      if (existingReceipt.requestId !== requestId) {
        fail('IDEMPOTENCY_CONFLICT', 'Promotion claim was already consumed by a different request.');
      }
      return consumptionResult(existingReceipt);
    }
    if (Date.parse(claim.expiresAt) <= store.clock()) fail('PROMOTION_CLAIM_EXPIRED', 'Promotion claim expired.');
    if (claim.subjectDigest !== expectedSubjectDigest) fail('PROMOTION_SUBJECT_MISMATCH', 'Promotion claim subject does not match delivery subject.');
    const consumeAgainst = async (current, authorityContext) => {
      const authorityBinding = validateAuthorityContext(authorityContext);
      if (current?.digest !== claim.publicationDigest || current?.runRevision !== claim.runRevision
        || current?.decisionRevision !== claim.decisionRevision || current?.finalSubjectDigest !== claim.subjectDigest
        || current?.decision?.superseded || current?.decision?.ready !== true
        || current?.decision?.grantedAuthority !== claim.authority
        || current?.decision?.executionManifestDigest !== claim.executionSetDigest
        || authorityBinding.storeMarkerDigest !== claim.storeMarkerDigest
        || authorityBinding.storeGeneration !== claim.storeGeneration
        || authorityBinding.activationEpoch !== claim.activationEpoch
        || authorityBinding.writerProtocol !== claim.writerProtocol
        || authorityBinding.selectorDigest !== claim.selectorDigest
        || authorityBinding.selectorRevision !== claim.selectorRevision
        || authorityBinding.activeBuildIdentity !== claim.activeBuildIdentity) {
        fail('PROMOTION_CLAIM_STALE', 'Release head changed after assertion; delivery is refused.');
      }
      const receipt = {
        schemaVersion: 1, kind: 'promotion-consumption-receipt', claimId: claim.id,
        requestId, principalId: principal.id, runId: claim.runId,
        subjectDigest: claim.subjectDigest, publicationDigest: claim.publicationDigest,
        consumedAt: new Date(store.clock()).toISOString(),
      };
      receipt.digest = canonicalDigest(receipt);
      try {
        await atomicWriteJson(store.storage, receiptPath, receipt, { mode: 0o600, exclusive: true });
      } catch (error) {
        if (error?.code === 'ATOMIC_ALREADY_EXISTS') {
          const raced = parseStoredReceipt(JSON.parse(await fs.readFile(receiptPath, 'utf8')), claim);
          if (raced.requestId !== requestId) {
            fail('IDEMPOTENCY_CONFLICT', 'Promotion claim was concurrently consumed by a different request.');
          }
          return raced;
        }
        throw error;
      }
      return receipt;
    };
    const receipt = await withCurrentPublication(consumeAgainst);
    return consumptionResult(receipt);
  })();
}
