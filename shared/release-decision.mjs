import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  nonEmptyString,
} from './canonical-contract.mjs';
import { parseExecutionManifest, parseOracleResult } from './execution-contract.mjs';
import {
  AUDIT_MODES,
  AUTHORITY_QUALIFIERS,
  parseCertifiedScope,
  parseCoverageBasis,
  parseFinalReleaseSubject,
} from './release-subject.mjs';

export const RELEASE_DECISION_CODES = Object.freeze([
  'RELEASE_READY',
  'FEATURE_READY',
  'NOT_READY_TEST_FAILURE',
  'NOT_READY_INCOMPLETE_EXECUTION',
]);

const DECISION_LABELS = Object.freeze({
  RELEASE_READY: 'RELEASE READY',
  FEATURE_READY: 'FEATURE READY',
  NOT_READY_TEST_FAILURE: 'NOT READY — TEST FAILURE',
  NOT_READY_INCOMPLETE_EXECUTION: 'NOT READY — INCOMPLETE EXECUTION',
});

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) failContract('INVALID_CONTRACT', `${label} must be a positive integer.`);
  return value;
}

function parseDisposition(value, index) {
  exactKeys(value, ['kind', 'executionId', 'reason', 'authorized', 'actor'], `releaseDispositions[${index}]`);
  if (value.kind !== 'visual-defect') {
    failContract('INVALID_CONTRACT', `releaseDispositions[${index}].kind is unsupported.`);
  }
  if (value.authorized !== true) failContract('UNAUTHORIZED_RELEASE_DISPOSITION', 'Visual defect disposition must be explicitly authorized.');
  exactKeys(value.actor, ['id', 'kind'], `releaseDispositions[${index}].actor`);
  return {
    kind: value.kind,
    executionId: nonEmptyString(value.executionId, `releaseDispositions[${index}].executionId`),
    reason: nonEmptyString(value.reason, `releaseDispositions[${index}].reason`),
    authorized: true,
    actor: {
      id: nonEmptyString(value.actor.id, `releaseDispositions[${index}].actor.id`),
      kind: nonEmptyString(value.actor.kind, `releaseDispositions[${index}].actor.kind`),
    },
  };
}

function reason(reasonClass, executionId, detail) {
  return { class: reasonClass, executionId, detail };
}

export function deriveReleaseDecision(value) {
  assertSchemaVersion(value, 'Release decision input');
  exactKeys(value, [
    'schemaVersion', 'runId', 'decisionRevision', 'finalSubject', 'executionManifest',
    'oracleResults', 'releaseDispositions',
  ], 'Release decision input');
  const finalSubject = parseFinalReleaseSubject(value.finalSubject);
  const manifest = parseExecutionManifest(value.executionManifest);
  if (manifest.digest !== finalSubject.executionManifestDigest || manifest.subjectCoreDigest !== finalSubject.subjectCoreDigest) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Release decision inputs do not share one sealed subject.');
  }
  if (!Array.isArray(value.oracleResults)) failContract('INVALID_CONTRACT', 'oracleResults must be an array.');
  const declaredIds = manifest.oracleExecutions.map(({ id }) => id);
  const suppliedIds = value.oracleResults.map((result) => result?.oracleExecutionId);
  if (suppliedIds.some((id) => !declaredIds.includes(id))) {
    failContract('UNDECLARED_EXECUTION_RESULT', 'Release decision contains an undeclared oracle result.');
  }
  if (new Set(suppliedIds).size !== suppliedIds.length) {
    failContract('DUPLICATE_EXECUTION_RESULT', 'Release decision contains duplicate oracle results.');
  }
  const oracleResults = value.oracleResults.map(parseOracleResult).sort((left, right) => left.oracleExecutionId.localeCompare(right.oracleExecutionId));
  if (JSON.stringify(oracleResults.map(({ oracleExecutionId }) => oracleExecutionId)) !== JSON.stringify(declaredIds)) {
    failContract('INCOMPLETE_EXECUTION_SET', 'Release decision requires one canonical result for every oracle execution.');
  }
  if (oracleResults.some((result) => result.finalSubjectDigest !== finalSubject.digest
    || result.subjectCoreDigest !== finalSubject.subjectCoreDigest)) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'An oracle result is stale or belongs to another subject.');
  }
  const workById = new Map(manifest.workItems.map((item) => [item.id, item]));
  const declaredOracleById = new Map(manifest.oracleExecutions.map((oracle) => [oracle.id, oracle]));
  for (const result of oracleResults) {
    const declared = declaredOracleById.get(result.oracleExecutionId);
    const expectedPolicy = {
      definitionId: declared.definitionId,
      requiredWorkItemIds: declared.requiredWorkItemIds,
      productOracleVariant: declared.productOracleVariant ?? `${declared.definitionId}:all-required`,
      baselinePolicy: declared.baselinePolicy ?? 'not-applicable',
      workItemBindings: declared.workItemBindings ?? declared.requiredWorkItemIds.map((workItemId) => ({
        workItemId,
        targetRole: workById.get(workItemId)?.targetRole,
        comparisonKey: workById.get(workItemId)?.targetId,
      })),
    };
    const actualPolicy = {
      definitionId: result.definitionId,
      requiredWorkItemIds: result.adoptedWorkItemIds,
      productOracleVariant: result.productOracleVariant ?? `${result.definitionId}:all-required`,
      baselinePolicy: result.baselinePolicy ?? 'not-applicable',
      workItemBindings: result.workItemBindings ?? result.adoptedWorkItemIds.map((workItemId) => ({
        workItemId,
        targetRole: workById.get(workItemId)?.targetRole,
        comparisonKey: workById.get(workItemId)?.targetId,
      })),
    };
    if (JSON.stringify(actualPolicy) !== JSON.stringify(expectedPolicy)) {
      failContract('ORACLE_POLICY_MISMATCH', `Oracle result ${result.oracleExecutionId} does not match its sealed manifest policy.`);
    }
  }
  if (!Array.isArray(value.releaseDispositions)) failContract('INVALID_CONTRACT', 'releaseDispositions must be an array.');
  const dispositions = value.releaseDispositions.map(parseDisposition);
  if (dispositions.some(({ executionId }) => !declaredIds.includes(executionId))) {
    failContract('UNDECLARED_EXECUTION_RESULT', 'A release disposition names an undeclared oracle execution.');
  }

  const productReasons = [
    ...oracleResults.filter(({ outcome }) => outcome === 'completed_product_failure')
      .map(({ oracleExecutionId }) => reason('product-failure', oracleExecutionId, 'A canonical Product Oracle failed.')),
    ...dispositions.filter(({ kind }) => kind === 'visual-defect')
      .map(({ executionId, reason: detail }) => reason('product-failure', executionId, detail)),
  ];
  const operationalReasons = [
    ...oracleResults.filter(({ workItemOutcomes }) => workItemOutcomes.some(({ outcome }) => outcome === 'operational_failure'))
      .map(({ oracleExecutionId }) => reason('operational-incident', oracleExecutionId, 'A canonical execution ended with an operational incident.')),
    ...oracleResults.filter(({ workItemOutcomes }) => workItemOutcomes.some(({ outcome }) => ['cancelled', 'incomplete_unknown'].includes(outcome)))
      .map(({ oracleExecutionId }) => reason('incomplete-execution', oracleExecutionId, 'Canonical execution did not complete.')),
  ];
  const code = productReasons.length > 0
    ? 'NOT_READY_TEST_FAILURE'
    : operationalReasons.length > 0
      ? 'NOT_READY_INCOMPLETE_EXECUTION'
      : finalSubject.grantedAuthority.qualifier === 'FULL' ? 'RELEASE_READY' : 'FEATURE_READY';
  const body = {
    schemaVersion: 1,
    kind: 'release-decision',
    runId: nonEmptyString(value.runId, 'runId'),
    decisionRevision: positiveInteger(value.decisionRevision, 'decisionRevision'),
    subjectDigest: finalSubject.digest,
    executionManifestDigest: manifest.digest,
    mode: finalSubject.mode,
    grantedAuthority: finalSubject.grantedAuthority.qualifier,
    certifiedScope: finalSubject.grantedAuthority.scope,
    coverageBasis: finalSubject.coverageBasis,
    code,
    label: DECISION_LABELS[code],
    ready: code === 'RELEASE_READY' || code === 'FEATURE_READY',
    blockingReasons: [...productReasons, ...operationalReasons],
    superseded: false,
    exitCode: code === 'RELEASE_READY' || code === 'FEATURE_READY' ? 0 : 1,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseReleaseDecision(value) {
  assertSchemaVersion(value, 'Release decision');
  exactKeys(value, [
    'schemaVersion', 'kind', 'runId', 'decisionRevision', 'subjectDigest', 'executionManifestDigest',
    'mode', 'grantedAuthority', 'certifiedScope', 'coverageBasis', 'code', 'label', 'ready',
    'blockingReasons', 'superseded', 'exitCode', 'digest',
  ], 'Release decision');
  if (value.kind !== 'release-decision' || !RELEASE_DECISION_CODES.includes(value.code)) {
    failContract('INVALID_CONTRACT', 'Release decision kind or code is invalid.');
  }
  if (!AUTHORITY_QUALIFIERS.includes(value.grantedAuthority)) failContract('INVALID_CONTRACT', 'Release decision authority is invalid.');
  if (!AUDIT_MODES.includes(value.mode)) failContract('INVALID_CONTRACT', 'Release decision mode is invalid.');
  const ready = value.code === 'RELEASE_READY' || value.code === 'FEATURE_READY';
  if (value.label !== DECISION_LABELS[value.code] || value.ready !== ready || value.exitCode !== (ready ? 0 : 1)) {
    failContract('CORRUPT_DECISION', 'Release decision fields contradict its stable code.');
  }
  if ((value.code === 'RELEASE_READY') !== (value.grantedAuthority === 'FULL')
    && ready) failContract('CORRUPT_DECISION', 'Ready decision code contradicts granted authority.');
  if (typeof value.superseded !== 'boolean' || !Array.isArray(value.blockingReasons)) {
    failContract('INVALID_CONTRACT', 'Release decision supersession or blocking reasons are invalid.');
  }
  const blockingReasons = value.blockingReasons.map((entry, index) => {
    exactKeys(entry, ['class', 'executionId', 'detail'], `blockingReasons[${index}]`);
    if (!['product-failure', 'incomplete-execution', 'operational-incident'].includes(entry.class)) {
      failContract('INVALID_CONTRACT', `blockingReasons[${index}].class is unsupported.`);
    }
    return {
      class: entry.class,
      executionId: nonEmptyString(entry.executionId, `blockingReasons[${index}].executionId`),
      detail: nonEmptyString(entry.detail, `blockingReasons[${index}].detail`),
    };
  });
  if (ready === (blockingReasons.length > 0)) {
    failContract('CORRUPT_DECISION', 'Release decision readiness contradicts its blocking reasons.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'release-decision',
    runId: nonEmptyString(value.runId, 'runId'),
    decisionRevision: positiveInteger(value.decisionRevision, 'decisionRevision'),
    subjectDigest: assertDigest(value.subjectDigest, 'subjectDigest'),
    executionManifestDigest: assertDigest(value.executionManifestDigest, 'executionManifestDigest'),
    mode: value.mode,
    grantedAuthority: value.grantedAuthority,
    certifiedScope: parseCertifiedScope(value.certifiedScope),
    coverageBasis: parseCoverageBasis(value.coverageBasis),
    code: value.code,
    label: value.label,
    ready: value.ready,
    blockingReasons,
    superseded: value.superseded,
    exitCode: value.exitCode,
  };
  if (canonicalDigest(body) !== value.digest) failContract('CORRUPT_DECISION', 'Release decision digest is corrupt.');
  return freezeContract({ ...body, digest: value.digest });
}

export function assertConsumableReleaseDecision(value, expected) {
  const decision = parseReleaseDecision(value);
  assertDigest(expected?.expectedSubjectDigest, 'expectedSubjectDigest');
  if (decision.subjectDigest !== expected.expectedSubjectDigest) {
    failContract('STALE_RELEASE_SUBJECT', 'Release decision does not match the subject intended for promotion.');
  }
  if (!AUTHORITY_QUALIFIERS.includes(expected.expectedAuthority)
    || decision.grantedAuthority !== expected.expectedAuthority) {
    failContract('AUTHORITY_SCOPE_MISMATCH', 'Release decision authority does not match consumption authority.');
  }
  if (decision.decisionRevision !== expected.currentDecisionRevision || decision.superseded) {
    failContract('STALE_DECISION_REVISION', 'Release decision revision is stale or superseded.');
  }
  if (!decision.ready) failContract(decision.code, decision.label);
  return decision;
}
