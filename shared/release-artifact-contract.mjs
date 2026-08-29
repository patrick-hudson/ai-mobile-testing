import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  nonEmptyString,
} from './canonical-contract.mjs';

const SAFE_SEGMENT = /^[^/\\\u0000-\u001f\u007f]{1,255}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function boundedInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    failContract('INVALID_CONTRACT', `${label} must be a safe integer of at least ${minimum}.`);
  }
  return value;
}

function relativePath(value, label) {
  nonEmptyString(value, label);
  if (value.length > 1_024 || value.startsWith('/') || value.endsWith('/') || value.includes('\\')) {
    failContract('INVALID_CONTRACT', `${label} must be a bounded POSIX relative path.`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    failContract('INVALID_CONTRACT', `${label} contains an unsafe path segment.`);
  }
  return value;
}

function exactOrigin(value, label, protocols = ['https:']) {
  nonEmptyString(value, label);
  let parsed;
  try { parsed = new URL(value); } catch { failContract('INVALID_CONTRACT', `${label} must be an exact origin.`); }
  if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash || parsed.origin !== value) {
    failContract('INVALID_CONTRACT', `${label} must be an exact ${protocols.join(' or ')} origin.`);
  }
  return parsed.origin;
}

function providerId(value, label) {
  if (typeof value !== 'string' || !SAFE_PROVIDER_ID.test(value)) {
    failContract('INVALID_CONTRACT', `${label} is invalid.`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    failContract('INVALID_CONTRACT', `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

export function sealReleaseArtifactManifest(value) {
  assertSchemaVersion(value, 'Release artifact manifest');
  exactKeys(value, ['schemaVersion', 'files'], 'Release artifact manifest');
  if (!Array.isArray(value.files) || value.files.length === 0) {
    failContract('INVALID_CONTRACT', 'Release artifact manifest must contain at least one file.');
  }
  const files = value.files.map((entry, index) => {
    exactKeys(entry, ['relativePath', 'size', 'digest'], `files[${index}]`);
    return {
      relativePath: relativePath(entry.relativePath, `files[${index}].relativePath`),
      size: boundedInteger(entry.size, `files[${index}].size`),
      digest: assertDigest(entry.digest, `files[${index}].digest`),
    };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (new Set(files.map(({ relativePath: file }) => file)).size !== files.length) {
    failContract('INVALID_CONTRACT', 'Release artifact manifest paths must be unique.');
  }
  const totalBytes = files.reduce((total, file) => {
    const next = total + file.size;
    if (!Number.isSafeInteger(next)) failContract('INVALID_CONTRACT', 'Release artifact byte total is unsafe.');
    return next;
  }, 0);
  const body = {
    schemaVersion: 1,
    kind: 'release-artifact-manifest',
    files,
    fileCount: files.length,
    totalBytes,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseReleaseArtifactManifest(value) {
  assertSchemaVersion(value, 'Release artifact manifest');
  exactKeys(value, ['schemaVersion', 'kind', 'files', 'fileCount', 'totalBytes', 'digest'], 'Release artifact manifest');
  if (value.kind !== 'release-artifact-manifest') failContract('INVALID_CONTRACT', 'Release artifact manifest kind is invalid.');
  const sealed = sealReleaseArtifactManifest({ schemaVersion: value.schemaVersion, files: value.files });
  if (value.fileCount !== sealed.fileCount || value.totalBytes !== sealed.totalBytes || value.digest !== sealed.digest) {
    failContract('CORRUPT_ARTIFACT_MANIFEST', 'Release artifact manifest digest, file count, or byte total is corrupt.');
  }
  return sealed;
}

export function sealAuditedCandidateDeployment(value) {
  assertSchemaVersion(value, 'Audited candidate deployment');
  exactKeys(value, [
    'schemaVersion', 'provider', 'accountId', 'projectName', 'deploymentId', 'deploymentUrl',
    'auditedOrigin', 'artifactManifestDigest', 'sourceRevision', 'createdAt',
  ], 'Audited candidate deployment');
  if (value.provider !== 'cloudflare-pages') {
    failContract('INVALID_CONTRACT', 'Audited candidate deployment provider is unsupported.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'audited-candidate-deployment',
    provider: value.provider,
    accountId: providerId(value.accountId, 'accountId'),
    projectName: providerId(value.projectName, 'projectName'),
    deploymentId: providerId(value.deploymentId, 'deploymentId'),
    deploymentUrl: exactOrigin(value.deploymentUrl, 'deploymentUrl'),
    auditedOrigin: exactOrigin(value.auditedOrigin, 'auditedOrigin', ['http:', 'https:']),
    artifactManifestDigest: assertDigest(value.artifactManifestDigest, 'artifactManifestDigest'),
    sourceRevision: nonEmptyString(value.sourceRevision, 'sourceRevision'),
    createdAt: timestamp(value.createdAt, 'createdAt'),
  };
  if (body.sourceRevision.length > 256) failContract('INVALID_CONTRACT', 'sourceRevision is too long.');
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseAuditedCandidateDeployment(value) {
  assertSchemaVersion(value, 'Audited candidate deployment');
  exactKeys(value, [
    'schemaVersion', 'kind', 'provider', 'accountId', 'projectName', 'deploymentId', 'deploymentUrl',
    'auditedOrigin', 'artifactManifestDigest', 'sourceRevision', 'createdAt', 'digest',
  ], 'Audited candidate deployment');
  if (value.kind !== 'audited-candidate-deployment') failContract('INVALID_CONTRACT', 'Audited candidate deployment kind is invalid.');
  const sealed = sealAuditedCandidateDeployment({
    schemaVersion: value.schemaVersion,
    provider: value.provider,
    accountId: value.accountId,
    projectName: value.projectName,
    deploymentId: value.deploymentId,
    deploymentUrl: value.deploymentUrl,
    auditedOrigin: value.auditedOrigin,
    artifactManifestDigest: value.artifactManifestDigest,
    sourceRevision: value.sourceRevision,
    createdAt: value.createdAt,
  });
  if (sealed.digest !== value.digest) failContract('CORRUPT_CANDIDATE_DEPLOYMENT', 'Audited candidate deployment digest is corrupt.');
  return sealed;
}
