import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  nonEmptyString,
} from './canonical-contract.mjs';

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) failContract('INVALID_CONTRACT', `${label} must be a positive integer.`);
  return value;
}

function timestamp(value, label) {
  nonEmptyString(value, label);
  try {
    if (new Date(value).toISOString() !== value) throw new TypeError();
  } catch {
    failContract('INVALID_CONTRACT', `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

export function sealInventoryCompilationFailure(value) {
  assertSchemaVersion(value, 'Inventory compilation failure input');
  exactKeys(value, [
    'schemaVersion', 'subjectCoreDigest', 'workItemId', 'terminalResultDigest', 'reason',
    'attemptCount', 'failedAt',
  ], 'Inventory compilation failure input');
  const body = {
    schemaVersion: 1,
    kind: 'inventory-compilation-failure',
    subjectCoreDigest: assertDigest(value.subjectCoreDigest, 'subjectCoreDigest'),
    workItemId: nonEmptyString(value.workItemId, 'workItemId'),
    terminalResultDigest: assertDigest(value.terminalResultDigest, 'terminalResultDigest'),
    reason: nonEmptyString(value.reason, 'reason'),
    attemptCount: positiveInteger(value.attemptCount, 'attemptCount'),
    failedAt: timestamp(value.failedAt, 'failedAt'),
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseInventoryCompilationFailure(value) {
  assertSchemaVersion(value, 'Inventory compilation failure');
  exactKeys(value, [
    'schemaVersion', 'kind', 'subjectCoreDigest', 'workItemId', 'terminalResultDigest', 'reason',
    'attemptCount', 'failedAt', 'digest',
  ], 'Inventory compilation failure');
  if (value.kind !== 'inventory-compilation-failure') failContract('INVALID_CONTRACT', 'Inventory compilation failure kind is invalid.');
  const sealed = sealInventoryCompilationFailure({
    schemaVersion: 1,
    subjectCoreDigest: value.subjectCoreDigest,
    workItemId: value.workItemId,
    terminalResultDigest: value.terminalResultDigest,
    reason: value.reason,
    attemptCount: value.attemptCount,
    failedAt: value.failedAt,
  });
  if (sealed.digest !== value.digest) failContract('CORRUPT_COMPILATION_FAILURE', 'Inventory compilation failure digest is corrupt.');
  return sealed;
}
