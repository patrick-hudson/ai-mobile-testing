import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STATUS_BYTES = 64 * 1024;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function pending(jobId) {
  return Object.freeze({
    schemaVersion: 1,
    jobId,
    status: 'pending',
    deadlineExceeded: false,
    executionState: null,
    finalizationDigest: null,
    failureDigest: null,
    reportRevision: null,
    reportPublicationDigest: null,
    visualPublicationDigest: null,
    visualEligibilityManifestDigest: null,
    mediaStageDigest: null,
    mediaQualityState: null,
    galleryPublicationDigest: null,
    galleryExportRevision: null,
    galleryIndexDigest: null,
    publicationBlocked: false,
  });
}

function validateStatus(value, jobId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.kind !== 'single-site-finalization-status'
    || value.jobId !== jobId
    || !['complete', 'incomplete', 'deadline-exceeded', 'invalid'].includes(value.status)
    || typeof value.deadlineExceeded !== 'boolean'
    || typeof value.executionState !== 'string'
    || typeof value.statusDigest !== 'string') {
    throw new Error(`Single-site finalization status for ${jobId} is invalid.`);
  }
  const { statusDigest, ...body } = value;
  if (digest(body) !== statusDigest) throw new Error(`Single-site finalization status for ${jobId} failed digest verification.`);
  const finalizationDigest = typeof value.finalizationDigest === 'string' ? value.finalizationDigest : null;
  const failureDigest = typeof value.failureDigest === 'string' ? value.failureDigest : null;
  const reportRevision = typeof value.reportRevision === 'string' ? value.reportRevision : null;
  const reportPublicationDigest = typeof value.reportPublicationDigest === 'string'
    ? value.reportPublicationDigest
    : null;
  const visualPublicationDigest = typeof value.visualPublicationDigest === 'string'
    ? value.visualPublicationDigest
    : null;
  const visualEligibilityManifestDigest = typeof value.visualEligibilityManifestDigest === 'string'
    ? value.visualEligibilityManifestDigest
    : null;
  const mediaStageDigest = typeof value.mediaStageDigest === 'string' ? value.mediaStageDigest : null;
  const mediaQualityState = typeof value.mediaQualityState === 'string' ? value.mediaQualityState : null;
  const galleryPublicationDigest = typeof value.galleryPublicationDigest === 'string'
    ? value.galleryPublicationDigest
    : null;
  const galleryExportRevision = typeof value.galleryExportRevision === 'string'
    ? value.galleryExportRevision
    : null;
  const galleryIndexDigest = typeof value.galleryIndexDigest === 'string' ? value.galleryIndexDigest : null;
  const publicationBlocked = value.status === 'incomplete'
    && value.publicationBlocked === true
    && /^[a-f0-9]{64}$/.test(finalizationDigest ?? '')
    && failureDigest === null
    && reportRevision === null
    && reportPublicationDigest === null
    && visualPublicationDigest === null
    && visualEligibilityManifestDigest === null
    && mediaStageDigest === null
    && mediaQualityState === null
    && galleryPublicationDigest === null
    && galleryExportRevision === null
    && galleryIndexDigest === null;
  if ((value.status === 'invalid') !== (failureDigest !== null)
    || (value.status === 'invalid') === (finalizationDigest !== null)) {
    throw new Error(`Single-site finalization status for ${jobId} has inconsistent evidence references.`);
  }
  const legacy = value.status !== 'invalid' && mediaStageDigest === null
    && mediaQualityState === null && galleryPublicationDigest === null
    && galleryExportRevision === null && galleryIndexDigest === null;
  const expectedReportRevision = legacy
    ? finalizationDigest?.slice(0, 32)
    : digest({ finalizationDigest, mediaStageDigest }).slice(0, 32);
  const galleryBindingValid = galleryExportRevision === null
    ? galleryIndexDigest === null
    : /^export_[A-Za-z0-9_-]+$/.test(galleryExportRevision)
      && /^[a-f0-9]{64}$/.test(galleryIndexDigest ?? '');
  const mediaBindingValid = legacy || (/^[a-f0-9]{64}$/.test(mediaStageDigest ?? '')
    && ['complete', 'incomplete'].includes(mediaQualityState ?? '')
    && /^[a-f0-9]{64}$/.test(galleryPublicationDigest ?? '')
    && galleryBindingValid
    && !(value.status === 'complete' && mediaQualityState !== 'complete'));
  if (value.status !== 'invalid' && !publicationBlocked
    && (!/^[a-f0-9]{32}$/.test(reportRevision ?? '')
      || !/^[a-f0-9]{64}$/.test(reportPublicationDigest ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(visualPublicationDigest ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(visualEligibilityManifestDigest ?? '')
      || reportRevision !== expectedReportRevision
      || !mediaBindingValid)) {
    throw new Error(`Single-site finalization status for ${jobId} has an invalid report binding.`);
  }
  if (value.status === 'invalid' && (reportRevision !== null || reportPublicationDigest !== null
    || visualPublicationDigest !== null || visualEligibilityManifestDigest !== null
    || mediaStageDigest !== null || mediaQualityState !== null || galleryPublicationDigest !== null
    || galleryExportRevision !== null || galleryIndexDigest !== null)) {
    throw new Error(`Invalid Single-site finalization status for ${jobId} must not authorize a report.`);
  }
  return Object.freeze({
    schemaVersion: 1,
    jobId,
    status: value.status,
    deadlineExceeded: value.deadlineExceeded,
    executionState: value.executionState,
    finalizationDigest,
    failureDigest,
    reportRevision,
    reportPublicationDigest,
    visualPublicationDigest,
    visualEligibilityManifestDigest,
    mediaStageDigest,
    mediaQualityState,
    galleryPublicationDigest,
    galleryExportRevision,
    galleryIndexDigest,
    publicationBlocked,
  });
}

export async function readSingleSiteFinalizationStatus(rootValue, jobId) {
  if (!JOB_ID.test(jobId)) throw new TypeError('Single-site finalization job ID is invalid.');
  const root = path.resolve(rootValue);
  const file = path.join(root, jobId, 'status.json');
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return pending(jobId);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_STATUS_BYTES) {
    throw new Error(`Single-site finalization status for ${jobId} is unsafe or oversized.`);
  }
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Single-site finalization status for ${jobId} escaped its configured root.`);
  }
  let document;
  try {
    document = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new Error(`Single-site finalization status for ${jobId} is not valid JSON.`);
  }
  return validateStatus(document, jobId);
}
