export const SINGLE_SITE_ADVISORY_SCHEMA_VERSION = 1;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unsupported fields: ${unknown.sort().join(', ')}.`);
}

export function disabledSingleSiteAdvisory() {
  return Object.freeze({
    schemaVersion: SINGLE_SITE_ADVISORY_SCHEMA_VERSION,
    aiReview: Object.freeze({ optedIn: false, model: null }),
  });
}

export function parseSingleSiteAdvisory(value) {
  if (value === undefined || value === null) return disabledSingleSiteAdvisory();
  if (!isRecord(value)) throw new TypeError('advisory must be an object.');
  exactKeys(value, ['schemaVersion', 'aiReview'], 'advisory');
  if (value.schemaVersion !== SINGLE_SITE_ADVISORY_SCHEMA_VERSION || !isRecord(value.aiReview)) {
    throw new TypeError(`advisory must use schemaVersion ${SINGLE_SITE_ADVISORY_SCHEMA_VERSION} and contain aiReview.`);
  }
  exactKeys(value.aiReview, ['optedIn', 'model'], 'advisory.aiReview');
  if (typeof value.aiReview.optedIn !== 'boolean') {
    throw new TypeError('advisory.aiReview.optedIn must be boolean.');
  }
  const model = value.aiReview.model;
  if (!value.aiReview.optedIn) {
    if (model !== null) throw new TypeError('advisory.aiReview.model must be null when AI review is not opted in.');
    return disabledSingleSiteAdvisory();
  }
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    throw new TypeError('advisory.aiReview.model must be a safe 1-80 character model ID when opted in.');
  }
  return Object.freeze({
    schemaVersion: SINGLE_SITE_ADVISORY_SCHEMA_VERSION,
    aiReview: Object.freeze({ optedIn: true, model }),
  });
}
