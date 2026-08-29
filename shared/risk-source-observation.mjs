import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  nonEmptyString,
} from './canonical-contract.mjs';
import { sealPublicationText } from './publication-text-policy.mjs';

export const RISK_SOURCE_PRODUCERS = Object.freeze(['visual', 'baseline', 'evidence-pipeline']);
export const RISK_SOURCE_PRODUCER_STATES = Object.freeze(['COMPLETE', 'NOT_APPLICABLE', 'UNAVAILABLE']);

const PRODUCER_CONTRACT = Object.freeze({
  visual: Object.freeze({
    category: 'unreviewed-visual-change',
    sourceKind: 'visual-result',
    reviewState: 'PENDING_REVIEW',
  }),
  baseline: Object.freeze({
    category: 'production-baseline-defect',
    sourceKind: 'baseline-result',
    reviewState: 'OPEN',
  }),
  'evidence-pipeline': Object.freeze({
    category: 'evidence-pipeline-limitation',
    sourceKind: 'evidence-pipeline',
    reviewState: 'OPEN',
  }),
});

function bounded(value, label, maximum = 2_048) {
  const parsed = nonEmptyString(value, label);
  if (parsed.length > maximum || parsed.includes('\0')) {
    failContract('INVALID_RISK_SOURCE_OBSERVATION', `${label} exceeds its bound.`);
  }
  return parsed;
}

function safeId(value, label) {
  const parsed = bounded(value, label, 128);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/.test(parsed)) {
    failContract('INVALID_RISK_SOURCE_OBSERVATION', `${label} is invalid.`);
  }
  return parsed;
}

function timestamp(value, label) {
  const parsed = bounded(value, label, 64);
  const date = new Date(parsed);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== parsed) {
    failContract('INVALID_RISK_SOURCE_OBSERVATION', `${label} must be a canonical ISO timestamp.`);
  }
  return parsed;
}

function parseProducerStates(value) {
  if (!Array.isArray(value) || value.length !== RISK_SOURCE_PRODUCERS.length) {
    failContract('MISSING_RISK_SOURCE_PRODUCER', 'Risk source observations must declare every canonical producer exactly once.');
  }
  const states = value.map((entry, index) => {
    exactKeys(entry, ['producer', 'status'], `producerStates[${index}]`);
    if (!RISK_SOURCE_PRODUCERS.includes(entry.producer)
      || !RISK_SOURCE_PRODUCER_STATES.includes(entry.status)) {
      failContract('UNDECLARED_RISK_SOURCE_PRODUCER', `producerStates[${index}] is unsupported.`);
    }
    return { producer: entry.producer, status: entry.status };
  }).sort((left, right) => left.producer.localeCompare(right.producer));
  if (new Set(states.map(({ producer }) => producer)).size !== RISK_SOURCE_PRODUCERS.length) {
    failContract('DUPLICATE_RISK_SOURCE_PRODUCER', 'Risk source producer declarations are missing or duplicated.');
  }
  return states;
}

function parseObservation(value, index, identity, producerStates) {
  exactKeys(value, [
    'producer', 'category', 'severity', 'source', 'explanation', 'recommendedAction', 'reviewState', 'observedAt',
  ], `observations[${index}]`);
  const contract = PRODUCER_CONTRACT[value.producer];
  const producerState = producerStates.find(({ producer }) => producer === value.producer);
  if (!contract || producerState?.status !== 'COMPLETE') {
    failContract('UNDECLARED_RISK_SOURCE_OBSERVATION', `observations[${index}] belongs to an unavailable or not-applicable producer.`);
  }
  exactKeys(value.source, ['kind', 'id'], `observations[${index}].source`);
  const source = {
    kind: bounded(value.source.kind, `observations[${index}].source.kind`, 128),
    id: sealPublicationText(value.source.id, { maximum: 512 }),
  };
  if (value.category !== contract.category || source.kind !== contract.sourceKind
    || value.reviewState !== contract.reviewState || !source.id.startsWith(`${identity.workItemId}:`)) {
    failContract('UNDECLARED_RISK_SOURCE_OBSERVATION', `observations[${index}] escaped its declared producer or work-item identity.`);
  }
  if (!['low', 'medium', 'high', 'critical'].includes(value.severity)) {
    failContract('INVALID_RISK_SOURCE_OBSERVATION', `observations[${index}].severity is unsupported.`);
  }
  return {
    producer: value.producer,
    category: value.category,
    severity: value.severity,
    source,
    explanation: sealPublicationText(value.explanation),
    recommendedAction: sealPublicationText(value.recommendedAction),
    reviewState: value.reviewState,
    observedAt: timestamp(value.observedAt, `observations[${index}].observedAt`),
  };
}

export function sealRiskSourceObservationSet(value) {
  assertSchemaVersion(value, 'Risk source observation set');
  exactKeys(value, [
    'schemaVersion', 'runId', 'workItemId', 'subjectCoreDigest', 'attempt', 'workerId',
    'producerStates', 'observations',
  ], 'Risk source observation set input');
  const identity = {
    runId: safeId(value.runId, 'runId'),
    workItemId: safeId(value.workItemId, 'workItemId'),
    subjectCoreDigest: assertDigest(value.subjectCoreDigest, 'subjectCoreDigest'),
    attempt: value.attempt,
    workerId: safeId(value.workerId, 'workerId'),
  };
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) {
    failContract('INVALID_RISK_SOURCE_OBSERVATION', 'attempt must be a positive integer.');
  }
  const producerStates = parseProducerStates(value.producerStates);
  if (!Array.isArray(value.observations) || value.observations.length > 256) {
    failContract('INVALID_RISK_SOURCE_OBSERVATION', 'observations must be a bounded array.');
  }
  const observations = value.observations
    .map((entry, index) => parseObservation(entry, index, identity, producerStates))
    .sort((left, right) => left.producer.localeCompare(right.producer)
      || left.source.kind.localeCompare(right.source.kind)
      || left.source.id.localeCompare(right.source.id));
  const observationKeys = observations.map(({ producer, source }) => `${producer}\0${source.kind}\0${source.id}`);
  if (new Set(observationKeys).size !== observationKeys.length) {
    failContract('DUPLICATE_RISK_SOURCE_OBSERVATION', 'Risk source observations contain a duplicate immutable identity.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'risk-source-observation-set',
    ...identity,
    producerStates,
    observations,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseRiskSourceObservationSet(value) {
  assertSchemaVersion(value, 'Risk source observation set');
  exactKeys(value, [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'subjectCoreDigest', 'attempt', 'workerId',
    'producerStates', 'observations', 'digest',
  ], 'Risk source observation set');
  if (value.kind !== 'risk-source-observation-set') {
    failContract('INVALID_RISK_SOURCE_OBSERVATION', 'Risk source observation set kind is invalid.');
  }
  const sealed = sealRiskSourceObservationSet({
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    workItemId: value.workItemId,
    subjectCoreDigest: value.subjectCoreDigest,
    attempt: value.attempt,
    workerId: value.workerId,
    producerStates: value.producerStates,
    observations: value.observations,
  });
  if (sealed.digest !== value.digest) {
    failContract('CORRUPT_RISK_SOURCE_OBSERVATION', 'Risk source observation set digest is corrupt.');
  }
  return sealed;
}

function parseManualObligation(value, index) {
  exactKeys(value, ['id', 'severity', 'explanation', 'recommendedAction'], `manualObligations[${index}]`);
  if (!['low', 'medium', 'high', 'critical'].includes(value.severity)) {
    failContract('INVALID_COMPILE_RISK_INPUT', `manualObligations[${index}].severity is unsupported.`);
  }
  return {
    id: safeId(value.id, `manualObligations[${index}].id`),
    severity: value.severity,
    explanation: sealPublicationText(value.explanation),
    recommendedAction: sealPublicationText(value.recommendedAction),
  };
}

export function sealCompileRiskInputs(value) {
  assertSchemaVersion(value, 'Compile risk inputs');
  exactKeys(value, ['schemaVersion', 'subjectCoreDigest', 'manualObligations'], 'Compile risk inputs');
  if (!Array.isArray(value.manualObligations) || value.manualObligations.length > 512) {
    failContract('INVALID_COMPILE_RISK_INPUT', 'manualObligations must be a bounded array.');
  }
  const manualObligations = value.manualObligations.map(parseManualObligation)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(manualObligations.map(({ id }) => id)).size !== manualObligations.length) {
    failContract('DUPLICATE_COMPILE_RISK_INPUT', 'Manual obligation IDs must be unique.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'sealed-compile-risk-inputs',
    subjectCoreDigest: assertDigest(value.subjectCoreDigest, 'subjectCoreDigest'),
    manualObligations,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseCompileRiskInputs(value) {
  assertSchemaVersion(value, 'Compile risk inputs');
  exactKeys(value, ['schemaVersion', 'kind', 'subjectCoreDigest', 'manualObligations', 'digest'], 'Compile risk inputs');
  if (value.kind !== 'sealed-compile-risk-inputs') {
    failContract('INVALID_COMPILE_RISK_INPUT', 'Compile risk input kind is invalid.');
  }
  const sealed = sealCompileRiskInputs({
    schemaVersion: value.schemaVersion,
    subjectCoreDigest: value.subjectCoreDigest,
    manualObligations: value.manualObligations,
  });
  if (sealed.digest !== value.digest) {
    failContract('CORRUPT_COMPILE_RISK_INPUT', 'Compile risk input digest is corrupt.');
  }
  return sealed;
}
