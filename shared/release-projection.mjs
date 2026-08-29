import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  nonEmptyString,
} from './canonical-contract.mjs';
import { parseExecutionManifest } from './execution-contract.mjs';
import { parsePublicationEnvelope } from './publication-envelope.mjs';
import { deriveReleaseDecision } from './release-decision.mjs';
import { parseFinalReleaseSubject } from './release-subject.mjs';
import { parseRisk, parseRiskRegister } from './risk-contract.mjs';

const VISUAL_DISPOSITIONS = new Set(['ACCEPTED', 'DEFECT_CONFIRMED']);
const LIFECYCLE_ACTIONS = new Set(['ACKNOWLEDGED', 'RESOLVED', 'SUPERSEDED']);

function positiveRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) failContract('INVALID_CONTRACT', `${label} must be a positive integer.`);
  return value;
}

function nonnegativeRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) failContract('INVALID_CONTRACT', `${label} must be a non-negative integer.`);
  return value;
}

function actor(value, label = 'actor') {
  exactKeys(value, ['id', 'kind'], label);
  return {
    id: nonEmptyString(value.id, `${label}.id`),
    kind: nonEmptyString(value.kind, `${label}.kind`),
  };
}

function timestamp(value, label) {
  nonEmptyString(value, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    failContract('INVALID_CONTRACT', `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function parseVisualDisposition(value, expectedRevision, previousDigest, identity) {
  exactKeys(value, [
    'schemaVersion', 'kind', 'reviewRevision', 'runId', 'mode', 'subjectDigest', 'executionId',
    'riskIdentity', 'disposition', 'actor', 'rationale', 'at', 'supersedes', 'previousDigest', 'digest',
  ], `visualDispositions[${expectedRevision - 1}]`);
  if (value.schemaVersion !== 1 || value.kind !== 'visual-disposition' || value.reviewRevision !== expectedRevision
    || !VISUAL_DISPOSITIONS.has(value.disposition)) {
    failContract('CORRUPT_VISUAL_DISPOSITION', 'Visual disposition shape or revision is invalid.');
  }
  if (value.runId !== identity.runId || value.mode !== identity.mode || value.subjectDigest !== identity.subjectDigest) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Visual disposition belongs to another run or release subject.');
  }
  if (value.previousDigest !== previousDigest) failContract('CORRUPT_DIGEST_CHAIN', 'Visual disposition history is broken.');
  const body = {
    schemaVersion: 1,
    kind: 'visual-disposition',
    reviewRevision: value.reviewRevision,
    runId: nonEmptyString(value.runId, 'visual disposition runId'),
    mode: value.mode,
    subjectDigest: assertDigest(value.subjectDigest, 'visual disposition subjectDigest'),
    executionId: nonEmptyString(value.executionId, 'visual disposition executionId'),
    riskIdentity: assertDigest(value.riskIdentity, 'visual disposition riskIdentity'),
    disposition: value.disposition,
    actor: actor(value.actor, 'visual disposition actor'),
    rationale: nonEmptyString(value.rationale, 'visual disposition rationale'),
    at: timestamp(value.at, 'visual disposition at'),
    supersedes: value.supersedes === null ? null : assertDigest(value.supersedes, 'visual disposition supersedes'),
    previousDigest,
  };
  if (canonicalDigest(body) !== value.digest) failContract('CORRUPT_VISUAL_DISPOSITION', 'Visual disposition digest is corrupt.');
  return freezeContract({ ...body, digest: value.digest });
}

export function parseVisualDispositionHistory(values) {
  if (!Array.isArray(values)) failContract('INVALID_CONTRACT', 'Visual disposition history must be an array.');
  if (values.length === 0) return freezeContract([]);
  const first = values[0];
  const identity = {
    runId: nonEmptyString(first?.runId, 'visual disposition runId'),
    mode: first?.mode,
    subjectDigest: assertDigest(first?.subjectDigest, 'visual disposition subjectDigest'),
  };
  if (!['single-site', 'comparative'].includes(identity.mode)) failContract('INVALID_CONTRACT', 'Visual disposition mode is invalid.');
  const parsed = [];
  for (let index = 0; index < values.length; index += 1) {
    const event = parseVisualDisposition(values[index], index + 1, parsed[index - 1]?.digest ?? null, identity);
    const priorForRisk = [...parsed].reverse().find(({ riskIdentity }) => riskIdentity === event.riskIdentity) ?? null;
    if (event.supersedes !== (priorForRisk?.digest ?? null)) {
      failContract('CORRUPT_VISUAL_DISPOSITION', 'Visual disposition supersession does not name the prior scoped disposition.');
    }
    if (parsed.length > 0 && Date.parse(event.at) < Date.parse(parsed.at(-1).at)) {
      failContract('CORRUPT_VISUAL_DISPOSITION', 'Visual disposition timestamps move backward.');
    }
    parsed.push(event);
  }
  return freezeContract(parsed);
}

export function appendVisualDisposition(historyValue, input) {
  const history = parseVisualDispositionHistory(historyValue);
  assertSchemaVersion(input, 'Visual disposition input');
  exactKeys(input, [
    'schemaVersion', 'expectedReviewRevision', 'runId', 'mode', 'subjectDigest', 'executionId',
    'riskIdentity', 'disposition', 'actor', 'rationale', 'at',
  ], 'Visual disposition input');
  if (nonnegativeRevision(input.expectedReviewRevision, 'expectedReviewRevision') !== history.length) {
    failContract('VISUAL_REVIEW_REVISION_CONFLICT', 'Visual review revision is stale.');
  }
  if (!['single-site', 'comparative'].includes(input.mode) || !VISUAL_DISPOSITIONS.has(input.disposition)) {
    failContract('INVALID_CONTRACT', 'Visual disposition mode or value is unsupported.');
  }
  if (history.length > 0 && (history[0].runId !== input.runId || history[0].mode !== input.mode
    || history[0].subjectDigest !== input.subjectDigest)) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Visual disposition cannot cross a run or release subject.');
  }
  const priorForRisk = [...history].reverse().find(({ riskIdentity }) => riskIdentity === input.riskIdentity) ?? null;
  const body = {
    schemaVersion: 1,
    kind: 'visual-disposition',
    reviewRevision: history.length + 1,
    runId: nonEmptyString(input.runId, 'visual disposition runId'),
    mode: input.mode,
    subjectDigest: assertDigest(input.subjectDigest, 'visual disposition subjectDigest'),
    executionId: nonEmptyString(input.executionId, 'visual disposition executionId'),
    riskIdentity: assertDigest(input.riskIdentity, 'visual disposition riskIdentity'),
    disposition: input.disposition,
    actor: actor(input.actor, 'visual disposition actor'),
    rationale: nonEmptyString(input.rationale, 'visual disposition rationale'),
    at: timestamp(input.at, 'visual disposition at'),
    supersedes: priorForRisk?.digest ?? null,
    previousDigest: history.at(-1)?.digest ?? null,
  };
  return freezeContract([...history, freezeContract({ ...body, digest: canonicalDigest(body) })]);
}

function lifecycleEvents(values, risks) {
  if (!Array.isArray(values)) failContract('INVALID_CONTRACT', 'riskLifecycleEvents must be an array.');
  const riskIds = new Set(risks.map(({ identity }) => identity));
  const parsed = values.map((value, index) => {
    exactKeys(value, ['riskIdentity', 'action', 'actor', 'at'], `riskLifecycleEvents[${index}]`);
    const riskIdentity = assertDigest(value.riskIdentity, `riskLifecycleEvents[${index}].riskIdentity`);
    if (!riskIds.has(riskIdentity)) failContract('UNKNOWN_RISK_IDENTITY', 'Risk lifecycle event names an unknown immutable source.');
    if (!LIFECYCLE_ACTIONS.has(value.action)) failContract('INVALID_CONTRACT', 'Risk lifecycle action is unsupported.');
    return {
      riskIdentity,
      action: value.action,
      actor: actor(value.actor, `riskLifecycleEvents[${index}].actor`),
      at: timestamp(value.at, `riskLifecycleEvents[${index}].at`),
    };
  });
  for (let index = 1; index < parsed.length; index += 1) {
    if (Date.parse(parsed[index].at) < Date.parse(parsed[index - 1].at)) {
      failContract('CORRUPT_RISK_LIFECYCLE', 'Risk lifecycle timestamps move backward.');
    }
  }
  return parsed;
}

function overlayRisks(riskSources, lifecycle, dispositions) {
  const latestEvent = new Map();
  for (const event of [...lifecycle, ...dispositions]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)
      || ('disposition' in left ? 1 : 0) - ('disposition' in right ? 1 : 0))) {
    latestEvent.set(event.riskIdentity, event);
  }
  return riskSources.map((risk) => {
    const event = latestEvent.get(risk.identity) ?? null;
    if (event === null) return risk;
    const reviewState = 'disposition' in event ? event.disposition : event.action;
    return parseRisk({
      ...risk,
      reviewState,
      actor: event.actor,
      updatedAt: event.at,
    });
  });
}

export function projectSharedReleaseView(input) {
  assertSchemaVersion(input, 'Shared release projection input');
  exactKeys(input, [
    'schemaVersion', 'runId', 'baseDecisionRevision', 'baseRiskRevision', 'finalSubject',
    'executionManifest', 'oracleResults', 'riskAvailability', 'riskSources', 'riskLifecycleEvents',
    'visualDispositions',
  ], 'Shared release projection input');
  const finalSubject = parseFinalReleaseSubject(input.finalSubject);
  const manifest = parseExecutionManifest(input.executionManifest);
  const runId = nonEmptyString(input.runId, 'runId');
  const baseDecisionRevision = positiveRevision(input.baseDecisionRevision, 'baseDecisionRevision');
  const baseRiskRevision = positiveRevision(input.baseRiskRevision, 'baseRiskRevision');
  if (!Array.isArray(input.riskSources)) failContract('INVALID_CONTRACT', 'riskSources must be an array.');
  const riskSources = input.riskSources.map(parseRisk);
  if (riskSources.some(({ mode }) => mode !== finalSubject.mode)) failContract('RELEASE_SUBJECT_MISMATCH', 'Risk source mode disagrees with the release subject.');
  const lifecycle = lifecycleEvents(input.riskLifecycleEvents, riskSources);
  const dispositions = parseVisualDispositionHistory(input.visualDispositions);
  if (dispositions.some((entry) => entry.runId !== runId || entry.mode !== finalSubject.mode
    || entry.subjectDigest !== finalSubject.digest)) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Visual disposition disagrees with projection identity.');
  }
  const riskIds = new Set(riskSources.map(({ identity }) => identity));
  if (dispositions.some(({ riskIdentity }) => !riskIds.has(riskIdentity))) {
    failContract('UNKNOWN_RISK_IDENTITY', 'Visual disposition names an unknown immutable risk source.');
  }
  const activeDispositions = [...new Map(dispositions.map((entry) => [entry.riskIdentity, entry])).values()];
  const riskRegister = parseRiskRegister({
    schemaVersion: 1,
    availability: input.riskAvailability,
    risks: overlayRisks(riskSources, lifecycle, activeDispositions),
  });
  const decisionRevision = baseDecisionRevision + dispositions.length;
  const decision = deriveReleaseDecision({
    schemaVersion: 1,
    runId,
    decisionRevision,
    finalSubject,
    executionManifest: manifest,
    oracleResults: input.oracleResults,
    releaseDispositions: activeDispositions
      .filter(({ disposition }) => disposition === 'DEFECT_CONFIRMED')
      .map((entry) => ({
        kind: 'visual-defect',
        executionId: entry.executionId,
        reason: entry.rationale,
        authorized: true,
        actor: entry.actor,
      })),
  });
  return freezeContract({
    schemaVersion: 1,
    subjectDigest: finalSubject.digest,
    decision,
    riskRegister,
    decisionRevision,
    riskRevision: baseRiskRevision + lifecycle.length + dispositions.length,
    visualDispositionRevision: dispositions.length,
  });
}

export function projectPublicationView(value) {
  const envelope = parsePublicationEnvelope(value);
  const releaseTruth = freezeContract({
    decision: envelope.decision.ready ? 'READY' : 'NOT_READY',
    decisionCode: envelope.decision.code,
    ready: envelope.decision.ready,
    reason: envelope.decision.label,
    decisionBasis: 'Shared canonical oracle results and authorized release-affecting dispositions.',
    blockingFailures: envelope.decision.blockingReasons.filter(({ class: reasonClass }) => reasonClass === 'product-failure').length,
    blockingIncomplete: envelope.decision.blockingReasons.filter(({ class: reasonClass }) => reasonClass !== 'product-failure').length,
    baselineIssues: envelope.riskSummary.active,
    runIntegrityFailure: envelope.decision.code === 'NOT_READY_INCOMPLETE_EXECUTION',
    authority: envelope.decision.grantedAuthority,
    certifiedScope: envelope.decision.certifiedScope,
    subjectDigest: envelope.decision.subjectDigest,
    decisionRevision: envelope.decision.decisionRevision,
    superseded: envelope.decision.superseded,
    riskSummary: envelope.riskSummary,
    source: 'release/publication/current.json',
    evaluatedAt: null,
  });
  return freezeContract({
    schemaVersion: 1,
    subjectDigest: envelope.finalSubjectDigest,
    decision: envelope.decision,
    riskRegister: envelope.riskRegister,
    riskSummary: envelope.riskSummary,
    revisions: {
      run: envelope.runRevision,
      decision: envelope.decisionRevision,
      risk: envelope.riskRevision,
    },
    releaseTruth,
  });
}
