import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  canonicalJson,
  exactKeys,
  failContract,
  freezeContract,
  isRecord,
  nonEmptyString,
  uniqueStrings,
} from './canonical-contract.mjs';
import { parseExecutionManifest } from './execution-contract.mjs';

export const AUDIT_MODES = Object.freeze(['single-site', 'comparative']);
export const AUTHORITY_QUALIFIERS = Object.freeze(['FULL', 'TARGETED']);

function httpOrigin(value, label) {
  nonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    failContract('INVALID_CONTRACT', `${label} must be an exact HTTP(S) origin.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) {
    failContract('INVALID_CONTRACT', `${label} must be an exact HTTP(S) origin.`);
  }
  return parsed.origin;
}

function parseDeploymentIdentity(value, label = 'deploymentIdentity') {
  exactKeys(value, ['kind', 'value'], label);
  return {
    kind: nonEmptyString(value.kind, `${label}.kind`),
    value: nonEmptyString(value.value, `${label}.value`),
  };
}

function parseTargets(value, mode) {
  if (!Array.isArray(value) || value.length === 0) {
    failContract('INVALID_CONTRACT', 'Release subject targets must be non-empty.');
  }
  const targets = value.map((target, index) => {
    exactKeys(target, ['role', 'origin'], `targets[${index}]`);
    return {
      role: nonEmptyString(target.role, `targets[${index}].role`),
      origin: httpOrigin(target.origin, `targets[${index}].origin`),
    };
  }).sort((left, right) => left.role.localeCompare(right.role) || left.origin.localeCompare(right.origin));
  if (new Set(targets.map(({ role }) => role)).size !== targets.length) {
    failContract('INVALID_CONTRACT', 'Release subject target roles must be unique.');
  }
  if (mode === 'comparative'
    && (!targets.some(({ role }) => role === 'candidate') || !targets.some(({ role }) => role === 'production'))) {
    failContract('INVALID_CONTRACT', 'Comparative release subjects require candidate and production targets.');
  }
  return targets;
}

export function parseCertifiedScope(value) {
  exactKeys(value, ['features', 'definitions', 'targets', 'knownLimits'], 'certified scope');
  return {
    features: uniqueStrings(value.features, 'certified scope.features', { nonEmpty: true }),
    definitions: uniqueStrings(value.definitions, 'certified scope.definitions', { nonEmpty: true }),
    targets: uniqueStrings(value.targets, 'certified scope.targets', { nonEmpty: true }),
    knownLimits: uniqueStrings(value.knownLimits, 'certified scope.knownLimits'),
  };
}

export function parseAuthority(value, label = 'authority') {
  exactKeys(value, ['qualifier', 'scope'], label);
  if (!AUTHORITY_QUALIFIERS.includes(value.qualifier)) {
    failContract('INVALID_CONTRACT', `${label}.qualifier must be FULL or TARGETED.`);
  }
  const scope = parseCertifiedScope(value.scope);
  return { qualifier: value.qualifier, scope };
}

export function parseCoverageBasis(value) {
  exactKeys(value, ['selectedDefinitions', 'selectedTargets', 'excludedAsNotApplicable'], 'coverageBasis');
  return {
    selectedDefinitions: uniqueStrings(value.selectedDefinitions, 'coverageBasis.selectedDefinitions', { nonEmpty: true }),
    selectedTargets: uniqueStrings(value.selectedTargets, 'coverageBasis.selectedTargets', { nonEmpty: true }),
    excludedAsNotApplicable: uniqueStrings(value.excludedAsNotApplicable, 'coverageBasis.excludedAsNotApplicable'),
  };
}

export function sealReleaseSubjectCore(value) {
  assertSchemaVersion(value, 'Release subject core');
  exactKeys(value, [
    'schemaVersion', 'deploymentIdentity', 'targets', 'mode', 'requestedAuthority', 'revisions',
    'environmentIdentity', 'certificatePolicy',
  ], 'Release subject core');
  if (!AUDIT_MODES.includes(value.mode)) failContract('INVALID_CONTRACT', 'Release subject mode is unsupported.');
  const targets = parseTargets(value.targets, value.mode);
  if (!isRecord(value.revisions)) failContract('INVALID_CONTRACT', 'Release subject revisions must be an object.');
  exactKeys(value.revisions, ['runner', 'plugins', 'targets', 'configuration'], 'Release subject revisions');
  const body = {
    schemaVersion: 1,
    kind: 'release-subject-core',
    deploymentIdentity: parseDeploymentIdentity(value.deploymentIdentity),
    targets,
    mode: value.mode,
    requestedAuthority: parseAuthority(value.requestedAuthority, 'requestedAuthority'),
    revisions: Object.fromEntries(Object.entries(value.revisions).map(([key, digest]) => [key, assertDigest(digest, `revisions.${key}`)])),
    environmentIdentity: assertDigest(value.environmentIdentity, 'environmentIdentity'),
    certificatePolicy: nonEmptyString(value.certificatePolicy, 'certificatePolicy'),
  };
  if (!['strict', 'preview-bypass'].includes(body.certificatePolicy)) {
    failContract('INVALID_CONTRACT', 'certificatePolicy must be strict or preview-bypass.');
  }
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseReleaseSubjectCore(value) {
  assertSchemaVersion(value, 'Release subject core');
  exactKeys(value, [
    'schemaVersion', 'kind', 'deploymentIdentity', 'targets', 'mode', 'requestedAuthority', 'revisions',
    'environmentIdentity', 'certificatePolicy', 'digest',
  ], 'Release subject core');
  if (value.kind !== 'release-subject-core') failContract('INVALID_CONTRACT', 'Release subject core kind is invalid.');
  const sealed = sealReleaseSubjectCore({
    schemaVersion: value.schemaVersion,
    deploymentIdentity: value.deploymentIdentity,
    targets: value.targets,
    mode: value.mode,
    requestedAuthority: value.requestedAuthority,
    revisions: value.revisions,
    environmentIdentity: value.environmentIdentity,
    certificatePolicy: value.certificatePolicy,
  });
  if (sealed.digest !== value.digest) failContract('CORRUPT_SUBJECT_DIGEST', 'Release subject core digest is corrupt.');
  return sealed;
}

export function sealFinalReleaseSubject(value) {
  assertSchemaVersion(value, 'Final release subject');
  exactKeys(value, [
    'schemaVersion', 'subjectCore', 'executionManifest', 'grantedAuthority', 'coverageBasis',
    'deploymentIdentityRecheck',
  ], 'Final release subject');
  const subjectCore = parseReleaseSubjectCore(value.subjectCore);
  const executionManifest = parseExecutionManifest(value.executionManifest);
  if (executionManifest.subjectCoreDigest !== subjectCore.digest) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Execution manifest is not bound to this subject core.');
  }
  const grantedAuthority = parseAuthority(value.grantedAuthority, 'grantedAuthority');
  if (canonicalJson(grantedAuthority) !== canonicalJson(subjectCore.requestedAuthority)) {
    failContract('AUTHORITY_SCOPE_MISMATCH', 'Requested and granted authority must agree exactly.');
  }
  const recheck = parseDeploymentIdentity(value.deploymentIdentityRecheck, 'deploymentIdentityRecheck');
  if (canonicalJson(recheck) !== canonicalJson(subjectCore.deploymentIdentity)) {
    failContract('RELEASE_SUBJECT_MISMATCH', 'Deployment identity changed before final subject seal.');
  }
  const coverageBasis = parseCoverageBasis(value.coverageBasis);
  const manifestDefinitions = [...new Set(executionManifest.oracleExecutions.map(({ definitionId }) => definitionId))].sort();
  const manifestTargets = [...new Set(executionManifest.workItems.map(({ targetId }) => targetId))].sort();
  const subjectRoles = subjectCore.targets.map(({ role }) => role).sort();
  const manifestRoles = [...new Set(executionManifest.workItems.map(({ targetRole }) => targetRole))].sort();
  if (canonicalJson(coverageBasis.selectedDefinitions) !== canonicalJson(manifestDefinitions)
    || canonicalJson(coverageBasis.selectedTargets) !== canonicalJson(manifestTargets)
    || canonicalJson(manifestRoles) !== canonicalJson(subjectRoles)
    || canonicalJson(grantedAuthority.scope.definitions) !== canonicalJson(coverageBasis.selectedDefinitions)
    || canonicalJson(grantedAuthority.scope.targets) !== canonicalJson(coverageBasis.selectedTargets)) {
    failContract('AUTHORITY_SCOPE_MISMATCH', 'Coverage basis does not match the sealed oracle manifest.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'final-release-subject',
    subjectCoreDigest: subjectCore.digest,
    executionManifestDigest: executionManifest.digest,
    mode: subjectCore.mode,
    deploymentIdentity: subjectCore.deploymentIdentity,
    targets: subjectCore.targets,
    grantedAuthority,
    coverageBasis,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseFinalReleaseSubject(value) {
  assertSchemaVersion(value, 'Final release subject');
  exactKeys(value, [
    'schemaVersion', 'kind', 'subjectCoreDigest', 'executionManifestDigest', 'mode', 'deploymentIdentity',
    'targets', 'grantedAuthority', 'coverageBasis', 'digest',
  ], 'Final release subject');
  if (value.kind !== 'final-release-subject' || !AUDIT_MODES.includes(value.mode)) {
    failContract('INVALID_CONTRACT', 'Final release subject kind or mode is invalid.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'final-release-subject',
    subjectCoreDigest: assertDigest(value.subjectCoreDigest, 'subjectCoreDigest'),
    executionManifestDigest: assertDigest(value.executionManifestDigest, 'executionManifestDigest'),
    mode: value.mode,
    deploymentIdentity: parseDeploymentIdentity(value.deploymentIdentity),
    targets: parseTargets(value.targets, value.mode),
    grantedAuthority: parseAuthority(value.grantedAuthority, 'grantedAuthority'),
    coverageBasis: parseCoverageBasis(value.coverageBasis),
  };
  if (canonicalDigest(body) !== value.digest) failContract('CORRUPT_SUBJECT_DIGEST', 'Final release subject digest is corrupt.');
  return freezeContract({ ...body, digest: value.digest });
}
