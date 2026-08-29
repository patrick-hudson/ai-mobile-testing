import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  nonEmptyString,
} from './canonical-contract.mjs';
import { parseReleaseDecision } from './release-decision.mjs';
import { parseRiskRegister, summarizeRiskRegister } from './risk-contract.mjs';

function revision(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    failContract('INVALID_CONTRACT', `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return value;
}

function parseLedgerSequences(value) {
  exactKeys(value, ['observations', 'decisions', 'risks'], 'ledgerSequences');
  return {
    observations: revision(value.observations, 'ledgerSequences.observations', { allowZero: true }),
    decisions: revision(value.decisions, 'ledgerSequences.decisions', { allowZero: true }),
    risks: revision(value.risks, 'ledgerSequences.risks', { allowZero: true }),
  };
}

function envelopeBody(value, previousEnvelopeDigest) {
  const decision = parseReleaseDecision(value.decision);
  const riskRegister = parseRiskRegister(value.riskRegister);
  const finalSubjectDigest = assertDigest(value.finalSubjectDigest, 'finalSubjectDigest');
  if (decision.subjectDigest !== finalSubjectDigest) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Publication decision does not match its final subject.');
  }
  if (decision.runId !== value.runId || decision.decisionRevision !== value.decisionRevision) {
    failContract('CORRUPT_PUBLICATION_ENVELOPE', 'Publication identity or decision revision disagrees with its decision.');
  }
  return {
    schemaVersion: 1,
    kind: 'release-publication-envelope',
    runId: nonEmptyString(value.runId, 'runId'),
    runRevision: revision(value.runRevision, 'runRevision'),
    decisionRevision: revision(value.decisionRevision, 'decisionRevision'),
    riskRevision: revision(value.riskRevision, 'riskRevision'),
    ledgerSequences: parseLedgerSequences(value.ledgerSequences),
    previousEnvelopeDigest,
    finalSubjectDigest,
    decision,
    riskRegister,
    riskSummary: summarizeRiskRegister(riskRegister),
  };
}

export function appendPublicationEnvelope(previous, value) {
  assertSchemaVersion(value, 'Publication envelope input');
  exactKeys(value, [
    'schemaVersion', 'runId', 'runRevision', 'decisionRevision', 'riskRevision', 'ledgerSequences',
    'finalSubjectDigest', 'decision', 'riskRegister',
  ], 'Publication envelope input');
  const parsedPrevious = previous === null ? null : parsePublicationEnvelope(previous);
  const body = envelopeBody(value, parsedPrevious?.digest ?? null);
  if (parsedPrevious !== null) {
    if (body.runId !== parsedPrevious.runId || body.finalSubjectDigest !== parsedPrevious.finalSubjectDigest) {
      failContract('RELEASE_SUBJECT_MISMATCH', 'Publication chain cannot cross runs or release subjects.');
    }
    if (body.runRevision !== parsedPrevious.runRevision + 1
      || body.decisionRevision < parsedPrevious.decisionRevision
      || body.decisionRevision > parsedPrevious.decisionRevision + 1
      || body.riskRevision < parsedPrevious.riskRevision
      || body.riskRevision > parsedPrevious.riskRevision + 1) {
      failContract('INVALID_PUBLICATION_REVISION', 'Publication revisions must advance monotonically by at most one.');
    }
    for (const key of Object.keys(body.ledgerSequences)) {
      if (body.ledgerSequences[key] < parsedPrevious.ledgerSequences[key]) {
        failContract('INVALID_PUBLICATION_REVISION', 'Publication ledger sequences cannot move backward.');
      }
    }
    if (body.decisionRevision === parsedPrevious.decisionRevision
      && body.decision.digest !== parsedPrevious.decision.digest) {
      failContract('CORRUPT_PUBLICATION_ENVELOPE', 'Decision content changed without a decision revision.');
    }
    if (body.riskRevision === parsedPrevious.riskRevision
      && body.riskSummary.digest !== parsedPrevious.riskSummary.digest) {
      failContract('CORRUPT_PUBLICATION_ENVELOPE', 'Risk Register content changed without a risk revision.');
    }
  }
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parsePublicationEnvelope(value) {
  assertSchemaVersion(value, 'Publication envelope');
  exactKeys(value, [
    'schemaVersion', 'kind', 'runId', 'runRevision', 'decisionRevision', 'riskRevision',
    'ledgerSequences', 'previousEnvelopeDigest', 'finalSubjectDigest', 'decision', 'riskRegister',
    'riskSummary', 'digest',
  ], 'Publication envelope');
  if (value.kind !== 'release-publication-envelope') failContract('INVALID_CONTRACT', 'Publication envelope kind is invalid.');
  const previousEnvelopeDigest = value.previousEnvelopeDigest === null
    ? null
    : assertDigest(value.previousEnvelopeDigest, 'previousEnvelopeDigest');
  const body = envelopeBody(value, previousEnvelopeDigest);
  if (canonicalDigest(body.riskSummary) !== canonicalDigest(value.riskSummary)) {
    failContract('CORRUPT_PUBLICATION_ENVELOPE', 'Publication risk summary is corrupt.');
  }
  if (canonicalDigest(body) !== value.digest) failContract('CORRUPT_PUBLICATION_ENVELOPE', 'Publication envelope digest is corrupt.');
  return freezeContract({ ...body, digest: value.digest });
}

export function verifyPublicationChain(values) {
  if (!Array.isArray(values) || values.length === 0) failContract('INVALID_CONTRACT', 'Publication chain must be non-empty.');
  const parsed = [];
  for (let index = 0; index < values.length; index += 1) {
    const expectedPrevious = index === 0 ? null : parsed[index - 1].digest;
    if (values[index]?.previousEnvelopeDigest !== expectedPrevious) {
      failContract('CORRUPT_DIGEST_CHAIN', `Publication envelope ${index} has a broken previous digest.`);
    }
    const envelope = parsePublicationEnvelope(values[index]);
    if (index > 0) {
      const previous = parsed[index - 1];
      if (envelope.runId !== previous.runId || envelope.finalSubjectDigest !== previous.finalSubjectDigest
        || envelope.runRevision !== previous.runRevision + 1) {
        failContract('CORRUPT_DIGEST_CHAIN', `Publication envelope ${index} breaks run identity or revision order.`);
      }
    }
    parsed.push(envelope);
  }
  return freezeContract(parsed);
}
