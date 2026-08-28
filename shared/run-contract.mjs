export const AUDIT_RUN_CONTRACT_SCHEMA_VERSION = 1;

const RUN_MODES = new Set(['comparative', 'single-site']);
const DEPLOYMENT_ROLES = new Set(['preview', 'production']);
const SCOPE_QUALIFIERS = new Set(['FULL', 'TARGETED']);
const CERTIFICATE_POLICIES = new Set(['strict', 'preview-bypass']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedHttpOrigin(value, label) {
  if (!nonEmptyString(value)) throw new Error(`${label} must be a non-empty HTTP(S) URL.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials.`);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${label} must identify an origin without a path, query, or fragment.`);
  }
  return parsed.origin;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !nonEmptyString(entry))) {
    throw new Error(`${label} must contain at least one non-empty string.`);
  }
  const normalized = value.map((entry) => entry.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates.`);
  return normalized;
}

function optionalStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !nonEmptyString(entry))) {
    throw new Error(`${label} must contain only non-empty strings.`);
  }
  const normalized = value.map((entry) => entry.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates.`);
  return normalized;
}

function parseScope(value) {
  if (!isRecord(value) || !SCOPE_QUALIFIERS.has(value.qualifier)) {
    throw new Error('scope.qualifier must be FULL or TARGETED.');
  }
  const unknownKeys = Object.keys(value).filter((key) => !['qualifier', 'pluginIds', 'auditIds', 'areas'].includes(key));
  if (unknownKeys.length > 0) throw new Error(`scope contains unsupported fields: ${unknownKeys.join(', ')}.`);
  const scope = {
    qualifier: value.qualifier,
    pluginIds: optionalStringArray(value.pluginIds, 'scope.pluginIds'),
    auditIds: optionalStringArray(value.auditIds, 'scope.auditIds'),
    areas: optionalStringArray(value.areas, 'scope.areas'),
  };
  if (scope.qualifier === 'FULL' && (scope.pluginIds.length || scope.auditIds.length || scope.areas.length)) {
    throw new Error('FULL scope must not contain plugin, audit, or area filters.');
  }
  if (scope.qualifier === 'TARGETED' && !(scope.pluginIds.length || scope.auditIds.length || scope.areas.length)) {
    throw new Error('TARGETED scope must select at least one plugin, audit, or area filter.');
  }
  return scope;
}

function rejectKeys(value, forbidden, mode) {
  const present = forbidden.filter((key) => value[key] !== undefined);
  if (present.length > 0) throw new Error(`${mode} run contract must not contain ${present.join(', ')}.`);
}

function rejectUnknownKeys(value, allowed, mode) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${mode} run contract contains unsupported fields: ${unknown.join(', ')}.`);
}

export function parseRunContract(value) {
  if (!isRecord(value)) throw new Error('Run contract must be an object.');
  if (value.schemaVersion !== AUDIT_RUN_CONTRACT_SCHEMA_VERSION) {
    throw new Error(`Run contract schemaVersion must be ${AUDIT_RUN_CONTRACT_SCHEMA_VERSION}.`);
  }
  if (!RUN_MODES.has(value.mode)) throw new Error('Run contract mode must be comparative or single-site.');
  const common = {
    schemaVersion: AUDIT_RUN_CONTRACT_SCHEMA_VERSION,
    mode: value.mode,
    targetIds: stringArray(value.targetIds, 'targetIds'),
    scope: parseScope(value.scope),
  };

  if (value.mode === 'comparative') {
    rejectKeys(value, ['url', 'deploymentRole', 'certificatePolicy'], 'Comparative');
    rejectUnknownKeys(value, ['schemaVersion', 'mode', 'productionUrl', 'candidateUrl', 'targetIds', 'scope'], 'Comparative');
    const productionUrl = normalizedHttpOrigin(value.productionUrl, 'productionUrl');
    const candidateUrl = normalizedHttpOrigin(value.candidateUrl, 'candidateUrl');
    if (productionUrl === candidateUrl) throw new Error('Comparative origins must be distinct.');
    return { ...common, mode: 'comparative', productionUrl, candidateUrl };
  }

  rejectKeys(value, ['productionUrl', 'candidateUrl'], 'Single-site');
  rejectUnknownKeys(value, ['schemaVersion', 'mode', 'url', 'deploymentRole', 'certificatePolicy', 'targetIds', 'scope'], 'Single-site');
  if (!DEPLOYMENT_ROLES.has(value.deploymentRole)) {
    throw new Error('deploymentRole must be preview or production.');
  }
  if (!CERTIFICATE_POLICIES.has(value.certificatePolicy)) {
    throw new Error('certificatePolicy must be strict or preview-bypass.');
  }
  if (value.certificatePolicy === 'preview-bypass' && value.deploymentRole !== 'preview') {
    throw new Error('preview-bypass is allowed only for a confirmed Preview deployment.');
  }
  return {
    ...common,
    mode: 'single-site',
    url: normalizedHttpOrigin(value.url, 'url'),
    deploymentRole: value.deploymentRole,
    certificatePolicy: value.certificatePolicy,
  };
}

export function parseStoredRunContract(value) {
  if (!isRecord(value)) throw new Error('Stored run contract must be an object.');
  if (value.mode !== undefined) return parseRunContract(value);
  const productionUrl = normalizedHttpOrigin(value.productionUrl, 'productionUrl');
  const candidateUrl = normalizedHttpOrigin(value.candidateUrl, 'candidateUrl');
  if (productionUrl === candidateUrl) throw new Error('Legacy comparative origins must be distinct.');
  return { ...value, mode: 'comparative-legacy', productionUrl, candidateUrl };
}
