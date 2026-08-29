import {
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  nonEmptyString,
} from './canonical-contract.mjs';
import { sealPublicationText } from './publication-text-policy.mjs';
import { AUDIT_MODES, parseCertifiedScope } from './release-subject.mjs';

export const RISK_AVAILABILITY_STATES = Object.freeze([
  'LOADING', 'PROVISIONAL', 'AVAILABLE', 'PARTIAL', 'EMPTY', 'UNAVAILABLE',
]);
export const RISK_REVIEW_STATES = Object.freeze([
  'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPERSEDED', 'PENDING_REVIEW', 'ACCEPTED', 'DEFECT_CONFIRMED',
]);

function timestamp(value, label) {
  nonEmptyString(value, label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    failContract('INVALID_CONTRACT', `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function parseSource(value) {
  exactKeys(value, ['kind', 'id'], 'risk source');
  return { kind: nonEmptyString(value.kind, 'risk source.kind'), id: sealPublicationText(value.id, { maximum: 512 }) };
}

function parseActor(value) {
  exactKeys(value, ['id', 'kind'], 'risk actor');
  return { id: nonEmptyString(value.id, 'risk actor.id'), kind: nonEmptyString(value.kind, 'risk actor.kind') };
}

export function riskIdentity(value) {
  const scope = parseCertifiedScope(value.scope);
  const source = parseSource(value.source);
  if (!AUDIT_MODES.includes(value.mode)) failContract('INVALID_CONTRACT', 'Risk mode is unsupported.');
  return canonicalDigest({
    schemaVersion: 1,
    category: nonEmptyString(value.category, 'risk category'),
    mode: value.mode,
    scope,
    source,
  });
}

export function parseRisk(value) {
  assertSchemaVersion(value, 'Risk record');
  exactKeys(value, [
    'schemaVersion', 'identity', 'category', 'severity', 'mode', 'scope', 'source', 'explanation',
    'recommendedAction', 'reviewState', 'releaseEffect', 'actor', 'observedAt', 'updatedAt',
  ], 'Risk record');
  if (!['low', 'medium', 'high', 'critical'].includes(value.severity)) {
    failContract('INVALID_CONTRACT', 'Risk severity is unsupported.');
  }
  if (!RISK_REVIEW_STATES.includes(value.reviewState)) failContract('INVALID_CONTRACT', 'Risk reviewState is unsupported.');
  if (value.releaseEffect !== 'non-blocking') {
    failContract('RISK_CANNOT_AFFECT_RELEASE', 'Risk records are non-blocking and cannot enter release truth.');
  }
  const body = {
    schemaVersion: 1,
    category: nonEmptyString(value.category, 'risk category'),
    severity: value.severity,
    mode: value.mode,
    scope: parseCertifiedScope(value.scope),
    source: parseSource(value.source),
    explanation: sealPublicationText(value.explanation),
    recommendedAction: sealPublicationText(value.recommendedAction),
    reviewState: value.reviewState,
    releaseEffect: 'non-blocking',
    actor: parseActor(value.actor),
    observedAt: timestamp(value.observedAt, 'risk observedAt'),
    updatedAt: timestamp(value.updatedAt, 'risk updatedAt'),
  };
  if (new Date(body.updatedAt) < new Date(body.observedAt)) failContract('INVALID_CONTRACT', 'Risk updatedAt precedes observedAt.');
  const identity = riskIdentity(body);
  if (value.identity !== undefined && value.identity !== identity) failContract('CORRUPT_RISK_IDENTITY', 'Risk identity is corrupt.');
  return freezeContract({ ...body, identity });
}

export function parseRiskRegister(value) {
  assertSchemaVersion(value, 'Risk Register');
  exactKeys(value, ['schemaVersion', 'availability', 'risks'], 'Risk Register');
  if (!RISK_AVAILABILITY_STATES.includes(value.availability)) {
    failContract('INVALID_CONTRACT', 'Risk Register availability is unsupported.');
  }
  if (!Array.isArray(value.risks)) failContract('INVALID_CONTRACT', 'Risk Register risks must be an array.');
  const risks = value.risks.map(parseRisk).sort((left, right) => left.identity.localeCompare(right.identity));
  if (new Set(risks.map(({ identity }) => identity)).size !== risks.length) {
    failContract('DUPLICATE_RISK_IDENTITY', 'Risk Register contains duplicate risk identities.');
  }
  if (['LOADING', 'EMPTY', 'UNAVAILABLE'].includes(value.availability) && risks.length !== 0) {
    failContract('INVALID_CONTRACT', `${value.availability} Risk Register cannot claim loaded risks.`);
  }
  if (value.availability === 'AVAILABLE' && risks.length === 0) {
    failContract('INVALID_CONTRACT', 'An available zero-risk register must use EMPTY availability.');
  }
  return freezeContract({ schemaVersion: 1, availability: value.availability, risks });
}

export function summarizeRiskRegister(value) {
  const register = parseRiskRegister(value);
  const active = register.risks.filter(({ reviewState }) => !['RESOLVED', 'SUPERSEDED', 'ACCEPTED'].includes(reviewState));
  return freezeContract({
    availability: register.availability,
    total: register.risks.length,
    active: active.length,
    bySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low'].map((severity) => [
      severity,
      active.filter((risk) => risk.severity === severity).length,
    ])),
    digest: canonicalDigest({ availability: register.availability, risks: register.risks }),
  });
}
