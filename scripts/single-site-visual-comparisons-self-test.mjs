import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VISUAL_CAPTURE_METADATA_CONTENT_TYPE,
  parseVisualBaselineEvidence,
  parseVisualBaselineIdentity,
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';
import { approveVisualBaseline, openVisualBaselineStore, readVisualBaselineStore } from '../portal/visual-baselines.mjs';
import {
  applyVisualComparisonsToSingleSiteReportInput,
  publishSingleSiteVisualComparisons,
  readSingleSiteVisualComparisonPublication,
} from './lib/single-site-visual-comparisons.mjs';
import {
  publishSingleSiteVisualComparisonsForTest,
  readSingleSiteVisualComparisonPublicationForTest,
} from './lib/single-site-visual-comparisons-test-support.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const identity = (capturePoint, overrides = {}) => parseVisualBaselineIdentity({
  schemaVersion: 1,
  mode: 'single-site',
  deploymentRole: 'preview',
  route: '/guide',
  targetId: 'single-site-desktop-chromium',
  viewport: { width: 4, height: 4 },
  theme: 'light',
  auditId: 'CONTENT-002',
  auditDefinitionDigest: digest('c'),
  capturePoint,
  browser: { engine: 'chromium', product: 'chromium', version: '140.0', build: 'chromium-140.0' },
  rendering: {
    devicePixelRatio: 1,
    captureContractRevision: 'single-site-static-checkpoint-v1',
    runnerImageDigest: digest('a'),
    fontPackDigest: digest('b'),
  },
  ...overrides,
});

function fakeImage(changedPixels = []) {
  const data = new Uint8Array(4 * 4 * 4);
  for (let pixel = 0; pixel < 16; pixel += 1) data.set([20, 30, 40, 255], pixel * 4);
  for (const pixel of changedPixels) data[pixel * 4] = 240;
  return Buffer.from(JSON.stringify({ width: 4, height: 4, data: [...data] }));
}

const fakeDependencies = {
  decodePng(bytes) {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return { width: value.width, height: value.height, data: Uint8Array.from(value.data) };
  },
  encodePng(image) {
    return Buffer.from(JSON.stringify({ width: image.width, height: image.height, data: [...image.data] }));
  },
  pixelmatch(left, right, output, width, height) {
    let count = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      const changed = left.subarray(offset, offset + 4).some((value, index) => value !== right[offset + index]);
      output.set(changed ? [255, 0, 0, 255] : [0, 0, 0, 0], offset);
      if (changed) count += 1;
    }
    return count;
  },
};

function metadata(captureIdentity, attachmentName) {
  return {
    schemaVersion: 1,
    kind: 'single-site-visual-capture',
    attachmentName,
    attachmentOccurrence: 0,
    identity: captureIdentity,
    identityKey: visualBaselineIdentityKey(captureIdentity),
    slotKey: visualBaselineSlotKey(captureIdentity),
  };
}

function playwrightResult(rows) {
  return {
    suites: [{ specs: rows.map((row) => ({
      title: row.name,
      tests: [{
        projectName: 'single-site-desktop-chromium',
        status: row.failed ? 'unexpected' : 'expected',
        expectedStatus: 'passed',
        annotations: [{ type: 'audit-case-id', description: `CONTENT-002:case:${row.name}` }],
        results: [{ attachments: [
          { name: row.name, contentType: 'image/png', ...(row.path ? { path: row.path } : {}) },
          {
            name: `visual-baseline-capture-${row.name}`,
            contentType: VISUAL_CAPTURE_METADATA_CONTENT_TYPE,
            body: Buffer.from(JSON.stringify(metadata(row.identity, row.name))).toString('base64'),
          },
          {
            name: 'audit-result',
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify({
              schemaVersion: 1,
              mode: 'single-site',
              caseId: `CONTENT-002:case:${row.name}`,
              auditId: 'CONTENT-002',
              project: 'single-site-desktop-chromium',
              evidenceAuthority: { status: 'authoritative', reasons: [] },
              findings: row.findings ?? [],
            })).toString('base64'),
          },
        ], status: row.failed ? 'failed' : 'passed' }],
      }],
    })) }],
    errors: [],
  };
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-visual-comparison-'));
try {
  const artifactRoot = path.join(temporary, 'artifacts');
  const baselineRoot = path.join(temporary, 'baselines');
  await fs.mkdir(artifactRoot, { recursive: true });
  const store = await openVisualBaselineStore({
    root: baselineRoot,
    clock: () => new Date('2026-08-25T12:00:00.000Z'),
    nonce: (() => { let index = 0; return () => `nonce-${++index}`; })(),
  });
  let revision = 0;
  async function approve(captureIdentity, name) {
    const bytes = fakeImage();
    const relativePath = `${name}.png`;
    await fs.writeFile(path.join(artifactRoot, relativePath), bytes);
    const result = await approveVisualBaseline(store, {
      expectedStoreRevision: revision,
      identity: captureIdentity,
      evidence: parseVisualBaselineEvidence({
        runId: 'baseline-source',
        artifactRelativePath: relativePath,
        artifactSha256: visualBaselineDigest(bytes),
        artifactBytes: bytes.length,
        contentType: 'image/png',
        runStatus: 'completed',
        evidenceComplete: true,
        evidenceAuthority: { status: 'authoritative', reasons: [] },
        findingStatus: 'clear',
        findingWaiver: null,
      }),
      runArtifactRoot: artifactRoot,
      actorId: 'reviewer',
      reason: 'Reviewed stable checkpoint.',
      idempotencyKey: `approve-${name}`,
    });
    revision = result.storeRevision;
  }

  const unchangedIdentity = identity('unchanged');
  const changedIdentity = identity('changed');
  const incompatibleBaselineIdentity = identity('incompatible');
  await approve(unchangedIdentity, 'baseline-unchanged');
  await approve(changedIdentity, 'baseline-changed');
  await approve(incompatibleBaselineIdentity, 'baseline-incompatible');
  assert.equal((await readVisualBaselineStore(store)).state.storeRevision, 3);

  const unchangedPath = path.join(artifactRoot, 'current-unchanged.png');
  const changedPath = path.join(artifactRoot, 'current-changed.png');
  const incompatiblePath = path.join(artifactRoot, 'current-incompatible.png');
  const absentPath = path.join(artifactRoot, 'current-absent.png');
  const findingPath = path.join(artifactRoot, 'current-finding.png');
  const unboundFailurePath = path.join(artifactRoot, 'current-unbound-failure.png');
  await fs.writeFile(unchangedPath, fakeImage());
  await fs.writeFile(changedPath, fakeImage([0]));
  await fs.writeFile(incompatiblePath, fakeImage());
  await fs.writeFile(absentPath, fakeImage());
  await fs.writeFile(findingPath, fakeImage());
  await fs.writeFile(unboundFailurePath, fakeImage());
  const incompatibleCurrentIdentity = identity('incompatible', {
    browser: { engine: 'chromium', product: 'chromium', version: '141.0', build: 'chromium-141.0' },
  });
  const absentIdentity = identity('absent');
  const results = playwrightResult([
    { name: 'unchanged', path: unchangedPath, identity: unchangedIdentity },
    { name: 'changed', path: changedPath, identity: changedIdentity },
    { name: 'finding', path: findingPath, identity: identity('finding'), failed: true },
    { name: 'unbound-failure', path: unboundFailurePath, identity: identity('unbound-failure'), failed: true },
    { name: 'incompatible', path: incompatiblePath, identity: incompatibleCurrentIdentity },
    { name: 'absent', path: absentPath, identity: absentIdentity },
    { name: 'unavailable', identity: identity('unavailable') },
  ]);
  const outputDir = path.join(temporary, 'publication');
  const publicationOptions = {
    playwrightResults: results,
    deterministicFindings: [{
      auditId: 'CONTENT-002',
      executionId: 'CONTENT-002:case:finding@single-site-desktop-chromium',
      source: 'playwright-assertion',
    }],
    artifactRoot,
    baselineStore: store,
    outputDir,
    jobId: 'run-001',
    attemptId: 'attempt-001',
    finalizationDigest: 'd'.repeat(64),
    reportRevision: 'e'.repeat(32),
    generatedAt: '2026-08-25T12:30:00.000Z',
    runStatus: 'completed',
    evidenceComplete: true,
    evidenceAuthority: { status: 'authoritative', reasons: [] },
  };
  const publication = await publishSingleSiteVisualComparisonsForTest(publicationOptions, fakeDependencies);
  assert.deepEqual(publication.items.map((item) => item.comparison.status), [
    'absent', 'CHANGED', 'absent', 'incompatible', 'unavailable', 'absent', 'UNCHANGED',
  ]);
  assert.equal(publication.policyEffects.deterministicFindings, 'none');
  assert.equal(publication.policyEffects.promotion, 'none');
  assert.equal(publication.comparatorCalibration.kind, 'visual-comparator-calibration-binding');
  assert.equal(publication.comparatorCalibration.defectCases, 6);
  assert.equal(publication.comparatorCalibration.acceptedNoiseCases, 2);
  assert.equal(publication.summary.attentionRequired, 1);
  assert.equal(publication.items.filter(({ diff }) => diff !== null).length, 2);
  const eligibility = JSON.parse(await fs.readFile(path.join(outputDir, 'eligibility.json'), 'utf8'));
  assert.equal(eligibility.kind, 'single-site-visual-baseline-eligibility');
  assert.deepEqual(eligibility.comparatorCalibration, publication.comparatorCalibration);
  assert.equal(eligibility.finalizationDigest, 'd'.repeat(64));
  assert.equal(eligibility.reportRevision, 'e'.repeat(32));
  assert.equal(eligibility.items.filter(({ eligible }) => eligible).length, 5);
  assert.equal(eligibility.items.filter(({ requiresFindingWaiver }) => requiresFindingWaiver).length, 1);
  const unboundFailure = eligibility.items.find(({ identity: itemIdentity }) => (
    itemIdentity.capturePoint === 'unbound-failure'
  ));
  assert.equal(unboundFailure.eligible, false);
  assert.match(unboundFailure.ineligibilityReasons.join(' '), /settled passing or deterministic-finding/);
  assert.equal(eligibility.items.find(({ evidence }) => evidence === null).eligible, false);
  assert.ok(eligibility.items.every(({ evidenceId }) => /^sha256:[a-f0-9]{64}$/.test(evidenceId)));
  const readOptions = {
    outputDir,
    jobId: 'run-001',
    attemptId: 'attempt-001',
    finalizationDigest: 'd'.repeat(64),
    reportRevision: 'e'.repeat(32),
  };
  assert.equal((await readSingleSiteVisualComparisonPublication(readOptions)).publicationDigest, publication.publicationDigest);
  assert.equal((await readSingleSiteVisualComparisonPublicationForTest(
    readOptions,
    'visual-comparator-real-png-v2',
  )).publicationDigest, publication.publicationDigest, 'v1 publication must remain readable after the current pointer advances');
  await publishSingleSiteVisualComparisonsForTest(publicationOptions, fakeDependencies);
  await assert.rejects(
    publishSingleSiteVisualComparisons({ ...publicationOptions, dependencies: fakeDependencies }),
    /does not permit dependency injection/,
  );

  const reportInput = {
    schemaVersion: 1,
    mode: 'single-site',
    generatedAt: '2026-08-25T12:30:00.000Z',
    health: { visualReview: { items: [{ status: 'absent' }] }, findings: [{ id: 'fixed' }] },
    audits: [{ id: 'CONTENT-002', visualStatus: 'absent', findingCount: 1 }],
    outsideMode: [],
  };
  const enriched = applyVisualComparisonsToSingleSiteReportInput(reportInput, publication);
  assert.equal(enriched.audits[0].visualStatus, 'CHANGED');
  assert.deepEqual(enriched.health.findings, reportInput.health.findings, 'visual review must not mutate deterministic findings');
  assert.equal(enriched.audits[0].findingCount, 1, 'visual review must not mutate deterministic finding counts');
  assert.equal(enriched.health.visualReview.items[0].status, 'CHANGED');

  const publicationPath = path.join(outputDir, 'visual-comparisons.json');
  const uncalibrated = JSON.parse(await fs.readFile(publicationPath, 'utf8'));
  delete uncalibrated.comparatorCalibration;
  const { publicationDigest: _oldDigest, ...uncalibratedBody } = uncalibrated;
  uncalibrated.publicationDigest = visualBaselineDigest(uncalibratedBody);
  await fs.writeFile(publicationPath, `${JSON.stringify(uncalibrated)}\n`);
  await assert.rejects(readSingleSiteVisualComparisonPublication({
    outputDir,
    jobId: 'run-001',
    attemptId: 'attempt-001',
    finalizationDigest: 'd'.repeat(64),
    reportRevision: 'e'.repeat(32),
  }), /published calibration binding must be an object/);

  console.log('single-site visual comparison self-test passed');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
