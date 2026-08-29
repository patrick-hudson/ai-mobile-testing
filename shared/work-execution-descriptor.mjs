import {
  assertDigest,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  isRecord,
  nonEmptyString,
} from './canonical-contract.mjs';

const CAPABILITY = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/;
const WORK_ITEM_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const SPEC_PATH = /^(?:tests|plugins\/[A-Za-z0-9._-]+\/tests)\/[A-Za-z0-9._/-]+\.spec\.ts$/;

function bounded(value, label, maximum = 512) {
  const normalized = nonEmptyString(value, label);
  if (normalized.length > maximum || normalized.includes('\0')) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', `${label} exceeds its bound.`);
  }
  return normalized;
}

function nullableBounded(value, label, maximum = 512) {
  return value === null ? null : bounded(value, label, maximum);
}

function exactOrigin(value, label) {
  const raw = bounded(value, label, 2_048);
  let parsed;
  try { parsed = new URL(raw); } catch {
    failContract('INVALID_EXECUTION_DESCRIPTOR', `${label} must be an HTTP(S) origin.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== raw) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', `${label} must be an exact credential-free HTTP(S) origin.`);
  }
  return parsed.origin;
}

function normalizeOrigins(value, mode) {
  exactKeys(value, ['candidate', 'production'], 'Execution descriptor origins');
  const candidate = exactOrigin(value.candidate, 'origins.candidate');
  const production = value.production === null ? null : exactOrigin(value.production, 'origins.production');
  if ((mode === 'comparative') !== (production !== null)) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Comparative descriptors require both origins; Single-site descriptors require one.');
  }
  return { candidate, production };
}

function normalizeRoute(value) {
  if (value === null) return null;
  exactKeys(value, ['inventoryDigest', 'url', 'path'], 'Execution descriptor route');
  const inventoryDigest = assertDigest(value.inventoryDigest, 'route.inventoryDigest');
  const url = bounded(value.url, 'route.url', 2_048);
  const routePath = bounded(value.path, 'route.path', 2_048);
  let parsed;
  try { parsed = new URL(url); } catch {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'route.url must be an HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== routePath) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'route URL and path bindings disagree.');
  }
  return { inventoryDigest, url, path: routePath };
}

export function sealWorkExecutionDescriptor(input) {
  exactKeys(input, [
    'workItemId', 'subjectCoreDigest', 'runnerRevision', 'mode', 'operation', 'definitionId', 'pluginId',
    'caseId', 'entrySpec', 'targetId', 'targetRole', 'capability', 'resourceClass', 'origins',
    'certificatePolicy', 'route',
  ], 'Work execution descriptor input');
  const workItemId = bounded(input.workItemId, 'workItemId', 128);
  if (!WORK_ITEM_ID.test(workItemId)) failContract('INVALID_EXECUTION_DESCRIPTOR', 'workItemId is invalid.');
  const mode = input.mode;
  const operation = input.operation;
  if (!['single-site', 'comparative'].includes(mode) || !['inventory', 'playwright'].includes(operation)) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Execution descriptor mode or operation is invalid.');
  }
  const capability = bounded(input.capability, 'capability', 128);
  const resourceClass = input.resourceClass;
  if (!CAPABILITY.test(capability) || !['ordinary', 'performance'].includes(resourceClass)) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Execution descriptor scheduling class is invalid.');
  }
  if ((capability === 'performance:lighthouse') !== (resourceClass === 'performance')) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Only the Lighthouse capability may use the performance resource class.');
  }
  if (operation === 'inventory' && (mode !== 'single-site' || capability !== 'inventory:http')) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Inventory execution requires the Single-site inventory capability.');
  }
  if (operation === 'playwright' && !/^(?:browser:(?:chromium|firefox|webkit|msedge)|performance:lighthouse)$/.test(capability)) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Playwright execution uses an unsupported repository capability.');
  }
  const entrySpec = nullableBounded(input.entrySpec, 'entrySpec', 512);
  const caseId = nullableBounded(input.caseId, 'caseId', 512);
  if (operation === 'inventory') {
    if (entrySpec !== null || caseId !== null || input.route !== null) {
      failContract('INVALID_EXECUTION_DESCRIPTOR', 'Inventory execution cannot carry Playwright selection fields.');
    }
  } else if (entrySpec === null || caseId === null || !SPEC_PATH.test(entrySpec)) {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Playwright execution requires a repository-owned spec and case ID.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'shared-work-execution-descriptor',
    workItemId,
    subjectCoreDigest: assertDigest(input.subjectCoreDigest, 'subjectCoreDigest'),
    runnerRevision: assertDigest(input.runnerRevision, 'runnerRevision'),
    mode,
    operation,
    definitionId: bounded(input.definitionId, 'definitionId', 256),
    pluginId: nullableBounded(input.pluginId, 'pluginId', 256),
    caseId,
    entrySpec,
    targetId: bounded(input.targetId, 'targetId', 128),
    targetRole: bounded(input.targetRole, 'targetRole', 128),
    capability,
    resourceClass,
    origins: normalizeOrigins(input.origins, mode),
    certificatePolicy: bounded(input.certificatePolicy, 'certificatePolicy', 64),
    route: normalizeRoute(input.route),
  };
  if (body.route !== null && body.mode !== 'single-site') {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Only Single-site work may carry an inventoried route binding.');
  }
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseWorkExecutionDescriptor(value) {
  if (!isRecord(value)) failContract('INVALID_EXECUTION_DESCRIPTOR', 'Work execution descriptor must be an object.');
  exactKeys(value, [
    'schemaVersion', 'kind', 'workItemId', 'subjectCoreDigest', 'runnerRevision', 'mode', 'operation',
    'definitionId', 'pluginId', 'caseId', 'entrySpec', 'targetId', 'targetRole', 'capability',
    'resourceClass', 'origins', 'certificatePolicy', 'route', 'digest',
  ], 'Work execution descriptor');
  if (value.schemaVersion !== 1 || value.kind !== 'shared-work-execution-descriptor') {
    failContract('INVALID_EXECUTION_DESCRIPTOR', 'Work execution descriptor schema is invalid.');
  }
  const parsed = sealWorkExecutionDescriptor({
    workItemId: value.workItemId,
    subjectCoreDigest: value.subjectCoreDigest,
    runnerRevision: value.runnerRevision,
    mode: value.mode,
    operation: value.operation,
    definitionId: value.definitionId,
    pluginId: value.pluginId,
    caseId: value.caseId,
    entrySpec: value.entrySpec,
    targetId: value.targetId,
    targetRole: value.targetRole,
    capability: value.capability,
    resourceClass: value.resourceClass,
    origins: value.origins,
    certificatePolicy: value.certificatePolicy,
    route: value.route,
  });
  if (parsed.digest !== value.digest) failContract('CORRUPT_EXECUTION_DIGEST', 'Work execution descriptor digest is corrupt.');
  return freezeContract(value);
}
