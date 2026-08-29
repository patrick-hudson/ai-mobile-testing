import {
  assertDigest,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  isRecord,
  nonEmptyString,
} from './canonical-contract.mjs';

export const WORK_ITEM_EVIDENCE_PURPOSES = Object.freeze(['structured', 'primary', 'diagnostic']);
export const MAX_WORK_ITEM_EVIDENCE_MEMBERS = 64;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i;

function bounded(value, label, maximum = 512) {
  const normalized = nonEmptyString(value, label);
  if (normalized.length > maximum || normalized.includes('\0')) failContract('INVALID_EVIDENCE_INDEX', `${label} exceeds its bound.`);
  return normalized;
}

function transportPath(value) {
  const normalized = bounded(value, 'member.transportPath', 240);
  const segments = normalized.split('/');
  if (normalized.startsWith('/') || normalized.includes('\\')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    failContract('INVALID_EVIDENCE_INDEX', 'member.transportPath must be a normalized relative path.');
  }
  return normalized;
}

export function sealWorkItemEvidenceMember(value) {
  exactKeys(value, [
    'workItemId', 'executionDescriptorDigest', 'ordinal', 'logicalName', 'purpose', 'mediaType',
    'sizeBytes', 'contentDigest', 'transportPath',
  ], 'Work-item evidence member');
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > MAX_WORK_ITEM_EVIDENCE_MEMBERS
    || !WORK_ITEM_EVIDENCE_PURPOSES.includes(value.purpose)
    || typeof value.mediaType !== 'string' || !MEDIA_TYPE.test(value.mediaType)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 512 * 1_048_576) {
    failContract('INVALID_EVIDENCE_INDEX', 'Work-item evidence member metadata is invalid.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'work-item-evidence-member',
    workItemId: bounded(value.workItemId, 'member.workItemId', 128),
    executionDescriptorDigest: assertDigest(value.executionDescriptorDigest, 'member.executionDescriptorDigest'),
    ordinal: value.ordinal,
    logicalName: bounded(value.logicalName, 'member.logicalName', 240),
    purpose: value.purpose,
    mediaType: value.mediaType.toLowerCase(),
    sizeBytes: value.sizeBytes,
    contentDigest: assertDigest(value.contentDigest, 'member.contentDigest'),
  };
  return freezeContract({ ...body, transportPath: transportPath(value.transportPath), memberDigest: canonicalDigest(body) });
}

function normalizeRow(value) {
  exactKeys(value, ['caseId', 'definitionId', 'entrySpec', 'targetId', 'status', 'evidencePolicy'], 'Evidence-index row');
  if (!['passed', 'failed', 'timedOut'].includes(value.status) || !isRecord(value.evidencePolicy)
    || !['interaction-video', 'static-screenshot', 'structured-data'].includes(value.evidencePolicy.mode)
    || typeof value.evidencePolicy.rationale !== 'string') {
    failContract('INVALID_EVIDENCE_INDEX', 'Evidence-index row is invalid.');
  }
  return {
    caseId: bounded(value.caseId, 'row.caseId', 512),
    definitionId: bounded(value.definitionId, 'row.definitionId', 256),
    entrySpec: bounded(value.entrySpec, 'row.entrySpec', 512),
    targetId: bounded(value.targetId, 'row.targetId', 128),
    status: value.status,
    evidencePolicy: {
      mode: value.evidencePolicy.mode,
      rationale: bounded(value.evidencePolicy.rationale, 'row.evidencePolicy.rationale', 500),
    },
  };
}

export function sealWorkItemEvidenceIndex(value) {
  exactKeys(value, ['workItemId', 'executionDescriptorDigest', 'row', 'members'], 'Work-item evidence index input');
  if (!Array.isArray(value.members) || value.members.length < 1 || value.members.length > MAX_WORK_ITEM_EVIDENCE_MEMBERS) {
    failContract('INVALID_EVIDENCE_INDEX', 'Work-item evidence index requires bounded members.');
  }
  const workItemId = bounded(value.workItemId, 'workItemId', 128);
  const executionDescriptorDigest = assertDigest(value.executionDescriptorDigest, 'executionDescriptorDigest');
  const members = value.members.map((member, index) => {
    const sealed = sealWorkItemEvidenceMember({
      ...member,
      workItemId,
      executionDescriptorDigest,
      ordinal: index + 1,
    });
    if (member.ordinal !== undefined && member.ordinal !== sealed.ordinal) {
      failContract('INVALID_EVIDENCE_INDEX', 'Evidence member order is not canonical.');
    }
    return sealed;
  });
  if (new Set(members.map(({ transportPath: itemPath }) => itemPath)).size !== members.length) {
    failContract('INVALID_EVIDENCE_INDEX', 'Evidence member transport paths must be unique.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'work-item-evidence-index',
    workItemId,
    executionDescriptorDigest,
    row: normalizeRow(value.row),
    members,
  };
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseWorkItemEvidenceIndex(value) {
  if (!isRecord(value)) failContract('INVALID_EVIDENCE_INDEX', 'Work-item evidence index must be an object.');
  exactKeys(value, ['schemaVersion', 'kind', 'workItemId', 'executionDescriptorDigest', 'row', 'members', 'digest'], 'Work-item evidence index');
  if (value.schemaVersion !== 1 || value.kind !== 'work-item-evidence-index') {
    failContract('INVALID_EVIDENCE_INDEX', 'Work-item evidence index schema is invalid.');
  }
  if (!Array.isArray(value.members)) {
    failContract('INVALID_EVIDENCE_INDEX', 'Work-item evidence index members must be an array.');
  }
  const sealed = sealWorkItemEvidenceIndex({
    workItemId: value.workItemId,
    executionDescriptorDigest: value.executionDescriptorDigest,
    row: value.row,
    members: value.members.map(({ ordinal, logicalName, purpose, mediaType, sizeBytes, contentDigest, transportPath }) => ({
      ordinal, logicalName, purpose, mediaType, sizeBytes, contentDigest, transportPath,
    })),
  });
  if (sealed.digest !== value.digest) failContract('CORRUPT_EVIDENCE_INDEX', 'Work-item evidence index digest is corrupt.');
  return sealed;
}
