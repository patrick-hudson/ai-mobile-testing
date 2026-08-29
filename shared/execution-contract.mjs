import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  nonEmptyString,
  uniqueStrings,
} from './canonical-contract.mjs';

export const WORK_ITEM_OUTCOMES = Object.freeze([
  'completed_pass',
  'completed_product_failure',
  'operational_failure',
  'cancelled',
  'incomplete_unknown',
]);
const MAX_WORK_ITEM_EVIDENCE_DIGESTS = 64;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) failContract('INVALID_CONTRACT', `${label} must be a positive integer.`);
  return value;
}

function orderedEvidenceDigests(value) {
  if (!Array.isArray(value) || value.length > MAX_WORK_ITEM_EVIDENCE_DIGESTS) {
    failContract('INVALID_CONTRACT', `evidenceDigests must be an array with at most ${MAX_WORK_ITEM_EVIDENCE_DIGESTS} entries.`);
  }
  return value.map((digest) => assertDigest(digest, 'evidenceDigests entry'));
}

function parseWorkItem(value, index) {
  exactKeys(value, ['id', 'definitionId', 'targetId', 'targetRole'], `workItems[${index}]`);
  return {
    id: nonEmptyString(value.id, `workItems[${index}].id`),
    definitionId: nonEmptyString(value.definitionId, `workItems[${index}].definitionId`),
    targetId: nonEmptyString(value.targetId, `workItems[${index}].targetId`),
    targetRole: nonEmptyString(value.targetRole, `workItems[${index}].targetRole`),
  };
}

function parseOracleExecution(value, index) {
  exactKeys(value, ['id', 'definitionId', 'requiredWorkItemIds'], `oracleExecutions[${index}]`);
  return {
    id: nonEmptyString(value.id, `oracleExecutions[${index}].id`),
    definitionId: nonEmptyString(value.definitionId, `oracleExecutions[${index}].definitionId`),
    requiredWorkItemIds: uniqueStrings(value.requiredWorkItemIds, `oracleExecutions[${index}].requiredWorkItemIds`, { nonEmpty: true }),
  };
}

export function sealExecutionManifest(value) {
  assertSchemaVersion(value, 'Execution manifest');
  exactKeys(value, ['schemaVersion', 'subjectCoreDigest', 'workItems', 'oracleExecutions', 'contextWorkItemIds'], 'Execution manifest');
  if (!Array.isArray(value.workItems) || !Array.isArray(value.oracleExecutions)
    || value.workItems.length === 0 || value.oracleExecutions.length === 0) {
    failContract('EMPTY_EXECUTION_MANIFEST', 'Execution manifest must declare required work and oracle executions.');
  }
  const workItems = value.workItems.map(parseWorkItem).sort((left, right) => left.id.localeCompare(right.id));
  const oracleExecutions = value.oracleExecutions.map(parseOracleExecution).sort((left, right) => left.id.localeCompare(right.id));
  const contextWorkItemIds = uniqueStrings(value.contextWorkItemIds, 'contextWorkItemIds');
  if (new Set(workItems.map(({ id }) => id)).size !== workItems.length
    || new Set(oracleExecutions.map(({ id }) => id)).size !== oracleExecutions.length) {
    failContract('DUPLICATE_EXECUTION_ID', 'Execution manifest IDs must be unique within their kind.');
  }
  const workIds = new Set(workItems.map(({ id }) => id));
  const workById = new Map(workItems.map((item) => [item.id, item]));
  const contextIds = new Set(contextWorkItemIds);
  for (const workItemId of contextIds) {
    if (!workIds.has(workItemId)) failContract('UNDECLARED_WORK_ITEM', `Context references undeclared work item ${workItemId}.`);
  }
  const adopted = new Set();
  for (const oracle of oracleExecutions) {
    for (const workItemId of oracle.requiredWorkItemIds) {
      if (!workIds.has(workItemId)) failContract('UNDECLARED_WORK_ITEM', `Oracle ${oracle.id} references undeclared work item ${workItemId}.`);
      if (contextIds.has(workItemId)) failContract('CONTEXT_WORK_ADOPTED', `Context work item ${workItemId} cannot be adopted by Product Oracle ${oracle.id}.`);
      if (workById.get(workItemId).definitionId !== oracle.definitionId) {
        failContract('ORACLE_DEFINITION_MISMATCH', `Oracle ${oracle.id} cannot adopt work item ${workItemId} from another definition.`);
      }
      if (adopted.has(workItemId)) failContract('DUPLICATE_WORK_ADOPTION', `Work item ${workItemId} is adopted by more than one oracle.`);
      adopted.add(workItemId);
    }
  }
  if (adopted.size + contextIds.size !== workItems.length) {
    failContract('UNADOPTED_WORK_ITEM', 'Every work item must be adopted by exactly one oracle or explicitly classified as context.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'execution-manifest',
    subjectCoreDigest: assertDigest(value.subjectCoreDigest, 'subjectCoreDigest'),
    workItems,
    oracleExecutions,
    contextWorkItemIds,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseExecutionManifest(value) {
  assertSchemaVersion(value, 'Execution manifest');
  exactKeys(value, ['schemaVersion', 'kind', 'subjectCoreDigest', 'workItems', 'oracleExecutions', 'contextWorkItemIds', 'digest'], 'Execution manifest');
  if (value.kind !== 'execution-manifest') failContract('INVALID_CONTRACT', 'Execution manifest kind is invalid.');
  const sealed = sealExecutionManifest({
    schemaVersion: value.schemaVersion,
    subjectCoreDigest: value.subjectCoreDigest,
    workItems: value.workItems,
    oracleExecutions: value.oracleExecutions,
    contextWorkItemIds: value.contextWorkItemIds,
  });
  if (sealed.digest !== value.digest) failContract('CORRUPT_EXECUTION_DIGEST', 'Execution manifest digest is corrupt.');
  return sealed;
}

export function sealWorkItemResult(value) {
  assertSchemaVersion(value, 'Work-item result');
  exactKeys(value, [
    'schemaVersion', 'workItemId', 'subjectCoreDigest', 'attempt', 'authoritative', 'outcome', 'evidenceDigests',
  ], 'Work-item result');
  if (typeof value.authoritative !== 'boolean') failContract('INVALID_CONTRACT', 'Work-item result authoritative must be boolean.');
  if (!WORK_ITEM_OUTCOMES.includes(value.outcome)) failContract('INVALID_CONTRACT', 'Work-item outcome is unsupported.');
  const body = {
    schemaVersion: 1,
    kind: 'work-item-result',
    workItemId: nonEmptyString(value.workItemId, 'workItemId'),
    subjectCoreDigest: assertDigest(value.subjectCoreDigest, 'subjectCoreDigest'),
    attempt: positiveInteger(value.attempt, 'attempt'),
    authoritative: value.authoritative,
    outcome: value.outcome,
    evidenceDigests: orderedEvidenceDigests(value.evidenceDigests),
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseWorkItemResult(value) {
  assertSchemaVersion(value, 'Work-item result');
  exactKeys(value, [
    'schemaVersion', 'kind', 'workItemId', 'subjectCoreDigest', 'attempt', 'authoritative', 'outcome',
    'evidenceDigests', 'digest',
  ], 'Work-item result');
  if (value.kind !== 'work-item-result') failContract('INVALID_CONTRACT', 'Work-item result kind is invalid.');
  const sealed = sealWorkItemResult({
    schemaVersion: value.schemaVersion,
    workItemId: value.workItemId,
    subjectCoreDigest: value.subjectCoreDigest,
    attempt: value.attempt,
    authoritative: value.authoritative,
    outcome: value.outcome,
    evidenceDigests: value.evidenceDigests,
  });
  if (sealed.digest !== value.digest) failContract('CORRUPT_EXECUTION_DIGEST', 'Work-item result digest is corrupt.');
  return sealed;
}

function oracleOutcome(results) {
  if (results.some(({ outcome }) => outcome === 'completed_product_failure')) return 'completed_product_failure';
  return results.every(({ outcome }) => outcome === 'completed_pass') ? 'completed_pass' : 'incomplete';
}

export function sealOracleResult(value) {
  assertSchemaVersion(value, 'Oracle result');
  exactKeys(value, ['schemaVersion', 'oracleExecution', 'finalSubjectDigest', 'workItemResults'], 'Oracle result');
  const oracleExecution = parseOracleExecution(value.oracleExecution, 0);
  if (!Array.isArray(value.workItemResults)) failContract('INVALID_CONTRACT', 'workItemResults must be an array.');
  const results = value.workItemResults.map(parseWorkItemResult).sort((left, right) => left.workItemId.localeCompare(right.workItemId));
  if (results.some(({ authoritative }) => !authoritative)) {
    failContract('NON_AUTHORITATIVE_RESULT', 'Diagnostic work-item results cannot seal a canonical oracle.');
  }
  const adoptedWorkItemIds = results.map(({ workItemId }) => workItemId);
  if (new Set(adoptedWorkItemIds).size !== adoptedWorkItemIds.length) {
    failContract('DUPLICATE_EXECUTION_RESULT', 'An oracle cannot adopt duplicate work-item results.');
  }
  if (JSON.stringify(adoptedWorkItemIds) !== JSON.stringify(oracleExecution.requiredWorkItemIds)) {
    failContract('ORACLE_ADOPTION_INCOMPLETE', 'Oracle result must adopt every and only declared work-item result.');
  }
  const subjectCoreDigests = [...new Set(results.map(({ subjectCoreDigest }) => subjectCoreDigest))];
  if (subjectCoreDigests.length !== 1) failContract('RELEASE_SUBJECT_MISMATCH', 'Oracle work-item results cross subject cores.');
  const body = {
    schemaVersion: 1,
    kind: 'oracle-result',
    oracleExecutionId: oracleExecution.id,
    definitionId: oracleExecution.definitionId,
    finalSubjectDigest: assertDigest(value.finalSubjectDigest, 'finalSubjectDigest'),
    subjectCoreDigest: subjectCoreDigests[0],
    adoptedWorkItemIds,
    workItemResultDigests: results.map(({ digest }) => digest),
    workItemOutcomes: results.map(({ workItemId, outcome }) => ({ workItemId, outcome })),
    outcome: oracleOutcome(results),
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseOracleResult(value) {
  assertSchemaVersion(value, 'Oracle result');
  exactKeys(value, [
    'schemaVersion', 'kind', 'oracleExecutionId', 'definitionId', 'finalSubjectDigest', 'subjectCoreDigest',
    'adoptedWorkItemIds', 'workItemResultDigests', 'workItemOutcomes', 'outcome', 'digest',
  ], 'Oracle result');
  if (value.kind !== 'oracle-result' || !['completed_pass', 'completed_product_failure', 'incomplete'].includes(value.outcome)) {
    failContract('INVALID_CONTRACT', 'Oracle result kind or outcome is invalid.');
  }
  if (!Array.isArray(value.workItemResultDigests)
    || value.workItemResultDigests.some((digest) => typeof digest !== 'string')
    || new Set(value.workItemResultDigests).size !== value.workItemResultDigests.length) {
    failContract('INVALID_CONTRACT', 'workItemResultDigests must be a unique ordered string array.');
  }
  if (!Array.isArray(value.workItemOutcomes) || value.workItemOutcomes.length === 0) {
    failContract('INVALID_CONTRACT', 'workItemOutcomes must be a non-empty array.');
  }
  const workItemOutcomes = value.workItemOutcomes.map((entry, index) => {
    exactKeys(entry, ['workItemId', 'outcome'], `workItemOutcomes[${index}]`);
    if (!WORK_ITEM_OUTCOMES.includes(entry.outcome)) failContract('INVALID_CONTRACT', `workItemOutcomes[${index}].outcome is unsupported.`);
    return { workItemId: nonEmptyString(entry.workItemId, `workItemOutcomes[${index}].workItemId`), outcome: entry.outcome };
  });
  const body = {
    schemaVersion: 1,
    kind: 'oracle-result',
    oracleExecutionId: nonEmptyString(value.oracleExecutionId, 'oracleExecutionId'),
    definitionId: nonEmptyString(value.definitionId, 'definitionId'),
    finalSubjectDigest: assertDigest(value.finalSubjectDigest, 'finalSubjectDigest'),
    subjectCoreDigest: assertDigest(value.subjectCoreDigest, 'subjectCoreDigest'),
    adoptedWorkItemIds: uniqueStrings(value.adoptedWorkItemIds, 'adoptedWorkItemIds', { nonEmpty: true }),
    workItemResultDigests: value.workItemResultDigests.map((digest) => assertDigest(digest, 'workItemResultDigests entry')),
    workItemOutcomes,
    outcome: value.outcome,
  };
  if (body.adoptedWorkItemIds.length !== body.workItemResultDigests.length
    || JSON.stringify(body.adoptedWorkItemIds) !== JSON.stringify(workItemOutcomes.map(({ workItemId }) => workItemId))) {
    failContract('CORRUPT_EXECUTION_DIGEST', 'Oracle result membership and digest counts disagree.');
  }
  if (oracleOutcome(workItemOutcomes) !== body.outcome) {
    failContract('CORRUPT_EXECUTION_DIGEST', 'Oracle outcome contradicts its adopted work-item outcomes.');
  }
  if (canonicalDigest(body) !== value.digest) failContract('CORRUPT_EXECUTION_DIGEST', 'Oracle result digest is corrupt.');
  return freezeContract({ ...body, digest: value.digest });
}
