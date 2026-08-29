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
const BASELINE_POLICIES = new Set([
  'not-applicable',
  'context-unless-candidate-regression-proven',
]);

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
  const canonical = value && typeof value === 'object'
    && ['productOracleVariant', 'baselinePolicy', 'workItemBindings'].some((key) => key in value);
  exactKeys(value, canonical
    ? ['id', 'definitionId', 'productOracleVariant', 'baselinePolicy', 'requiredWorkItemIds', 'workItemBindings']
    : ['id', 'definitionId', 'requiredWorkItemIds'], `oracleExecutions[${index}]`);
  const definitionId = nonEmptyString(value.definitionId, `oracleExecutions[${index}].definitionId`);
  const requiredWorkItemIds = uniqueStrings(value.requiredWorkItemIds, `oracleExecutions[${index}].requiredWorkItemIds`, { nonEmpty: true });
  if (!canonical) {
    return {
      id: nonEmptyString(value.id, `oracleExecutions[${index}].id`),
      definitionId,
      productOracleVariant: `${definitionId}:all-required`,
      baselinePolicy: 'not-applicable',
      requiredWorkItemIds,
      workItemBindings: null,
    };
  }
  if (!BASELINE_POLICIES.has(value.baselinePolicy) || !Array.isArray(value.workItemBindings)) {
    failContract('INVALID_CONTRACT', `oracleExecutions[${index}] has an invalid baseline policy or work-item bindings.`);
  }
  const workItemBindings = value.workItemBindings.map((binding, bindingIndex) => {
    exactKeys(binding, ['workItemId', 'targetRole', 'comparisonKey'], `oracleExecutions[${index}].workItemBindings[${bindingIndex}]`);
    return {
      workItemId: nonEmptyString(binding.workItemId, `oracleExecutions[${index}].workItemBindings[${bindingIndex}].workItemId`),
      targetRole: nonEmptyString(binding.targetRole, `oracleExecutions[${index}].workItemBindings[${bindingIndex}].targetRole`),
      comparisonKey: nonEmptyString(binding.comparisonKey, `oracleExecutions[${index}].workItemBindings[${bindingIndex}].comparisonKey`),
    };
  }).sort((left, right) => left.workItemId.localeCompare(right.workItemId));
  if (new Set(workItemBindings.map(({ workItemId }) => workItemId)).size !== workItemBindings.length
    || JSON.stringify(workItemBindings.map(({ workItemId }) => workItemId)) !== JSON.stringify([...requiredWorkItemIds].sort())) {
    failContract('INVALID_CONTRACT', `oracleExecutions[${index}] work-item bindings must cover every required work item exactly once.`);
  }
  return {
    id: nonEmptyString(value.id, `oracleExecutions[${index}].id`),
    definitionId,
    productOracleVariant: nonEmptyString(value.productOracleVariant, `oracleExecutions[${index}].productOracleVariant`),
    baselinePolicy: value.baselinePolicy,
    requiredWorkItemIds,
    workItemBindings,
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
  const parsedOracleExecutions = value.oracleExecutions.map(parseOracleExecution).sort((left, right) => left.id.localeCompare(right.id));
  const contextWorkItemIds = uniqueStrings(value.contextWorkItemIds, 'contextWorkItemIds');
  if (new Set(workItems.map(({ id }) => id)).size !== workItems.length
    || new Set(parsedOracleExecutions.map(({ id }) => id)).size !== parsedOracleExecutions.length) {
    failContract('DUPLICATE_EXECUTION_ID', 'Execution manifest IDs must be unique within their kind.');
  }
  const workIds = new Set(workItems.map(({ id }) => id));
  const workById = new Map(workItems.map((item) => [item.id, item]));
  const oracleExecutions = parsedOracleExecutions.map((oracle) => ({
    ...oracle,
    workItemBindings: oracle.workItemBindings ?? oracle.requiredWorkItemIds.map((workItemId) => ({
      workItemId,
      targetRole: workById.get(workItemId)?.targetRole ?? 'required',
      comparisonKey: workById.get(workItemId)?.targetId ?? workItemId,
    })).sort((left, right) => left.workItemId.localeCompare(right.workItemId)),
  }));
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
    for (const binding of oracle.workItemBindings) {
      if (workById.get(binding.workItemId)?.targetRole !== binding.targetRole) {
        failContract('ORACLE_ROLE_MISMATCH', `Oracle ${oracle.id} work-item role binding is invalid for ${binding.workItemId}.`);
      }
    }
    if (oracle.baselinePolicy === 'context-unless-candidate-regression-proven') {
      const boundRoles = new Set();
      for (const { comparisonKey, targetRole } of oracle.workItemBindings) {
        if (!['candidate', 'production'].includes(targetRole)) {
          failContract('ORACLE_ROLE_MISMATCH', `Comparative oracle ${oracle.id} contains unsupported role ${targetRole}.`);
        }
        const identity = `${comparisonKey}\u0000${targetRole}`;
        if (boundRoles.has(identity)) {
          failContract('ORACLE_ROLE_MISMATCH', `Comparative oracle ${oracle.id} repeats ${targetRole} for pair ${comparisonKey}.`);
        }
        boundRoles.add(identity);
      }
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
  const legacy = Array.isArray(value.oracleExecutions) && value.oracleExecutions.length > 0
    && value.oracleExecutions.every((oracle) => oracle && typeof oracle === 'object'
      && !('productOracleVariant' in oracle) && !('baselinePolicy' in oracle) && !('workItemBindings' in oracle));
  const sealed = sealExecutionManifest({
    schemaVersion: value.schemaVersion,
    subjectCoreDigest: value.subjectCoreDigest,
    workItems: value.workItems,
    oracleExecutions: value.oracleExecutions,
    contextWorkItemIds: value.contextWorkItemIds,
  });
  if (legacy) {
    const legacyBody = {
      schemaVersion: sealed.schemaVersion,
      kind: sealed.kind,
      subjectCoreDigest: sealed.subjectCoreDigest,
      workItems: sealed.workItems,
      oracleExecutions: sealed.oracleExecutions.map(({ id, definitionId, requiredWorkItemIds }) => ({
        id, definitionId, requiredWorkItemIds,
      })),
      contextWorkItemIds: sealed.contextWorkItemIds,
    };
    if (canonicalDigest(legacyBody) !== value.digest) {
      failContract('CORRUPT_EXECUTION_DIGEST', 'Execution manifest digest is corrupt.');
    }
    return freezeContract({ ...legacyBody, digest: value.digest });
  }
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

function oracleOutcome(oracleExecution, results) {
  if (oracleExecution.baselinePolicy === 'not-applicable') {
    if (results.some(({ outcome }) => outcome === 'completed_product_failure')) return 'completed_product_failure';
    return results.every(({ outcome }) => outcome === 'completed_pass') ? 'completed_pass' : 'incomplete';
  }
  const resultById = new Map(results.map((result) => [result.workItemId, result]));
  const groups = new Map();
  for (const binding of oracleExecution.workItemBindings) {
    const group = groups.get(binding.comparisonKey) ?? {};
    if (group[binding.targetRole]) failContract('INVALID_CONTRACT', `Oracle comparison pair ${binding.comparisonKey} repeats role ${binding.targetRole}.`);
    group[binding.targetRole] = resultById.get(binding.workItemId);
    groups.set(binding.comparisonKey, group);
  }
  let incomplete = false;
  for (const group of groups.values()) {
    const candidate = group.candidate;
    const production = group.production;
    if (candidate && !['completed_pass', 'completed_product_failure'].includes(candidate.outcome)) incomplete = true;
    if (production && !['completed_pass', 'completed_product_failure'].includes(production.outcome)) incomplete = true;
    if (candidate?.outcome === 'completed_product_failure') {
      if (production && !['completed_pass', 'completed_product_failure'].includes(production.outcome)) continue;
      if (production?.outcome !== 'completed_product_failure') return 'completed_product_failure';
    }
  }
  return incomplete ? 'incomplete' : 'completed_pass';
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
    productOracleVariant: oracleExecution.productOracleVariant,
    baselinePolicy: oracleExecution.baselinePolicy,
    workItemBindings: oracleExecution.workItemBindings,
    workItemOutcomes: results.map(({ workItemId, outcome }) => ({ workItemId, outcome })),
    outcome: oracleOutcome(oracleExecution, results),
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseOracleResult(value) {
  assertSchemaVersion(value, 'Oracle result');
  const legacy = value && typeof value === 'object'
    && !('productOracleVariant' in value) && !('baselinePolicy' in value) && !('workItemBindings' in value);
  exactKeys(value, legacy ? [
    'schemaVersion', 'kind', 'oracleExecutionId', 'definitionId', 'finalSubjectDigest', 'subjectCoreDigest',
    'adoptedWorkItemIds', 'workItemResultDigests', 'workItemOutcomes', 'outcome', 'digest',
  ] : [
    'schemaVersion', 'kind', 'oracleExecutionId', 'definitionId', 'finalSubjectDigest', 'subjectCoreDigest',
    'adoptedWorkItemIds', 'workItemResultDigests', 'productOracleVariant', 'baselinePolicy',
    'workItemBindings', 'workItemOutcomes', 'outcome', 'digest',
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
  const oracleExecution = parseOracleExecution({
    id: value.oracleExecutionId,
    definitionId: value.definitionId,
    requiredWorkItemIds: value.adoptedWorkItemIds,
    ...(legacy ? {} : {
      productOracleVariant: value.productOracleVariant,
      baselinePolicy: value.baselinePolicy,
      workItemBindings: value.workItemBindings,
    }),
  }, 0);
  const body = {
    schemaVersion: 1,
    kind: 'oracle-result',
    oracleExecutionId: nonEmptyString(value.oracleExecutionId, 'oracleExecutionId'),
    definitionId: nonEmptyString(value.definitionId, 'definitionId'),
    finalSubjectDigest: assertDigest(value.finalSubjectDigest, 'finalSubjectDigest'),
    subjectCoreDigest: assertDigest(value.subjectCoreDigest, 'subjectCoreDigest'),
    adoptedWorkItemIds: uniqueStrings(value.adoptedWorkItemIds, 'adoptedWorkItemIds', { nonEmpty: true }),
    workItemResultDigests: value.workItemResultDigests.map((digest) => assertDigest(digest, 'workItemResultDigests entry')),
    ...(!legacy ? {
      productOracleVariant: oracleExecution.productOracleVariant,
      baselinePolicy: oracleExecution.baselinePolicy,
      workItemBindings: oracleExecution.workItemBindings,
    } : {}),
    workItemOutcomes,
    outcome: value.outcome,
  };
  if (body.adoptedWorkItemIds.length !== body.workItemResultDigests.length
    || JSON.stringify(body.adoptedWorkItemIds) !== JSON.stringify(workItemOutcomes.map(({ workItemId }) => workItemId))) {
    failContract('CORRUPT_EXECUTION_DIGEST', 'Oracle result membership and digest counts disagree.');
  }
  if (oracleOutcome(oracleExecution, workItemOutcomes) !== body.outcome) {
    failContract('CORRUPT_EXECUTION_DIGEST', 'Oracle outcome contradicts its adopted work-item outcomes.');
  }
  if (canonicalDigest(body) !== value.digest) failContract('CORRUPT_EXECUTION_DIGEST', 'Oracle result digest is corrupt.');
  return freezeContract({ ...body, digest: value.digest });
}
