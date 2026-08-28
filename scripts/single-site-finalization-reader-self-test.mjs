import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSingleSiteFinalizationStatus } from '../portal/single-site-finalization.mjs';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-finalization-reader-'));
try {
  assert.equal((await readSingleSiteFinalizationStatus(root, 'job-pending')).status, 'pending');

  const jobDirectory = path.join(root, 'job-complete');
  await fs.mkdir(jobDirectory);
  const finalizationDigest = 'a'.repeat(64);
  const mediaStageDigest = 'e'.repeat(64);
  const body = {
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId: 'job-complete',
    status: 'complete',
    deadlineExceeded: false,
    executionState: 'completed',
    finalizationDigest,
    mediaStageDigest,
    mediaQualityState: 'complete',
    reportRevision: sha256({ finalizationDigest, mediaStageDigest }).slice(0, 32),
    reportPublicationDigest: 'b'.repeat(64),
    visualPublicationDigest: `sha256:${'c'.repeat(64)}`,
    visualEligibilityManifestDigest: `sha256:${'d'.repeat(64)}`,
    galleryPublicationDigest: 'f'.repeat(64),
    galleryExportRevision: 'export_fixture123',
    galleryIndexDigest: '1'.repeat(64),
  };
  await fs.writeFile(path.join(jobDirectory, 'status.json'), `${JSON.stringify({ ...body, statusDigest: sha256(body) })}\n`);
  const complete = await readSingleSiteFinalizationStatus(root, 'job-complete');
  assert.equal(complete.status, 'complete');
  assert.equal(complete.finalizationDigest, 'a'.repeat(64));
  assert.equal(complete.visualPublicationDigest, `sha256:${'c'.repeat(64)}`);
  assert.equal(complete.visualEligibilityManifestDigest, `sha256:${'d'.repeat(64)}`);
  assert.equal(complete.mediaStageDigest, mediaStageDigest);
  assert.equal(complete.mediaQualityState, 'complete');
  assert.equal(complete.galleryPublicationDigest, 'f'.repeat(64));
  assert.equal(complete.galleryExportRevision, 'export_fixture123');
  assert.equal(complete.galleryIndexDigest, '1'.repeat(64));
  assert.equal(complete.publicationBlocked, false);

  const blockedDirectory = path.join(root, 'job-deployment-changed');
  await fs.mkdir(blockedDirectory);
  const blockedBody = {
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId: 'job-deployment-changed',
    status: 'incomplete',
    deadlineExceeded: false,
    executionState: 'completed',
    finalizationDigest: '2'.repeat(64),
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
    publicationBlocked: true,
    incompleteReasonCode: 'SINGLE_SITE_FINALIZER_DEPLOYMENT_CHANGED',
    incompleteReason: 'Deployment revision changed before final publication.',
  };
  await fs.writeFile(path.join(blockedDirectory, 'status.json'), `${JSON.stringify({
    ...blockedBody,
    statusDigest: sha256(blockedBody),
  })}\n`);
  const blocked = await readSingleSiteFinalizationStatus(root, 'job-deployment-changed');
  assert.equal(blocked.status, 'incomplete');
  assert.equal(blocked.publicationBlocked, true);
  assert.equal(blocked.reportRevision, null);

  const unboundBlockedBody = { ...blockedBody, publicationBlocked: false };
  await fs.writeFile(path.join(blockedDirectory, 'status.json'), `${JSON.stringify({
    ...unboundBlockedBody,
    statusDigest: sha256(unboundBlockedBody),
  })}\n`);
  await assert.rejects(readSingleSiteFinalizationStatus(root, 'job-deployment-changed'), /invalid report binding/);

  const invalidReportBindingBody = { ...body, reportRevision: finalizationDigest.slice(0, 32) };
  await fs.writeFile(path.join(jobDirectory, 'status.json'), `${JSON.stringify({
    ...invalidReportBindingBody,
    statusDigest: sha256(invalidReportBindingBody),
  })}\n`);
  await assert.rejects(readSingleSiteFinalizationStatus(root, 'job-complete'), /invalid report binding/);

  const tampered = { ...body, status: 'incomplete', statusDigest: sha256(body) };
  await fs.writeFile(path.join(jobDirectory, 'status.json'), `${JSON.stringify(tampered)}\n`);
  await assert.rejects(readSingleSiteFinalizationStatus(root, 'job-complete'), /digest verification/);

  const outside = path.join(root, 'outside.json');
  await fs.writeFile(outside, '{}\n');
  const linkedDirectory = path.join(root, 'job-linked');
  await fs.mkdir(linkedDirectory);
  await fs.symlink(outside, path.join(linkedDirectory, 'status.json'));
  await assert.rejects(readSingleSiteFinalizationStatus(root, 'job-linked'), /unsafe or oversized/);
  await assert.rejects(readSingleSiteFinalizationStatus(root, '../escape'), /job ID is invalid/);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

process.stdout.write('Single-site finalization reader self-test passed: pending, digest validation, and containment fail closed.\n');
