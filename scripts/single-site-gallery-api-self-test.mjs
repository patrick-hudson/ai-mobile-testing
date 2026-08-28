import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openSingleSiteGallery,
  pageSingleSiteGalleryItems,
  readSingleSiteGalleryItem,
  resolveSingleSiteGalleryMedia,
  singleSiteGalleryHead,
  SingleSiteGalleryError,
} from '../portal/single-site-gallery.mjs';
import {
  parseVisualBaselineIdentity,
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';
import { createLiveGalleryDataSource } from '../portal/public/gallery-data-source.js';
import { buildSingleSiteReportDocuments } from './lib/site-health-report.mjs';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function bareDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

async function writePagedCaseIndex({ reportRoot, exportRevision, entries, pageRows = 100 }) {
  const pages = [];
  const pageDocuments = [];
  for (let offset = 0; offset < entries.length; offset += pageRows) {
    const selected = entries.slice(offset, offset + pageRows);
    const pageBody = {
      schemaVersion: 2,
      kind: 'single-site-gallery-index-page',
      mode: 'single-site',
      exportRevision,
      ordinal: pages.length + 1,
      entries: selected,
    };
    const pageDigest = bareDigest(pageBody);
    const relativePath = `pages/page-${String(pageBody.ordinal).padStart(6, '0')}-${pageDigest}.json`;
    pages.push({
      ordinal: pageBody.ordinal,
      itemCount: selected.length,
      firstItemId: selected[0].itemId,
      lastItemId: selected.at(-1).itemId,
      pageDigest,
      relativePath,
    });
    pageDocuments.push({ relativePath, document: { ...pageBody, pageDigest } });
  }
  const indexBody = {
    schemaVersion: 2,
    kind: 'single-site-gallery-index',
    mode: 'single-site',
    generatedAt: '2026-08-25T12:00:00.000Z',
    exportRevision,
    itemCount: entries.length,
    knownCaseCount: entries.filter(({ auditCaseId }) => auditCaseId !== null).length,
    pages,
  };
  const indexDigest = bareDigest(indexBody);
  const indexDocument = { ...indexBody, indexDigest };
  const indexRelativePath = `single-site-gallery-index/revisions/${indexDigest}/index.json`;
  const revisionDirectory = path.join(reportRoot, 'checklist', 'single-site-gallery-index', 'revisions', indexDigest);
  await fs.mkdir(path.join(revisionDirectory, 'pages'), { recursive: true });
  for (const page of pageDocuments) {
    await fs.writeFile(path.join(revisionDirectory, ...page.relativePath.split('/')), `${JSON.stringify(page.document)}\n`);
  }
  const indexFile = path.join(reportRoot, 'checklist', ...indexRelativePath.split('/'));
  await fs.writeFile(indexFile, `${JSON.stringify(indexDocument)}\n`);
  await fs.writeFile(path.join(reportRoot, 'checklist', 'single-site-gallery-index', 'current.json'), `${JSON.stringify({
    schemaVersion: 2,
    kind: 'single-site-gallery-index-pointer',
    indexDigest,
    exportRevision,
    relativePath: indexRelativePath,
    itemCount: entries.length,
  })}\n`);
  return { indexBody, indexDigest, indexDocument, indexFile, indexRelativePath, revisionDirectory };
}

function identity(route, auditId, capturePoint) {
  return parseVisualBaselineIdentity({
    schemaVersion: 1,
    mode: 'single-site',
    deploymentRole: 'preview',
    route,
    targetId: 'single-site-desktop-chromium',
    viewport: { width: 1280, height: 720 },
    theme: 'light',
    auditId,
    auditDefinitionDigest: `sha256:${'a'.repeat(64)}`,
    capturePoint,
    browser: { engine: 'chromium', product: 'Chromium', version: '140.0', build: 'fixture' },
    rendering: {
      devicePixelRatio: 1,
      captureContractRevision: 'v1',
      runnerImageDigest: `sha256:${'b'.repeat(64)}`,
      fontPackDigest: `sha256:${'c'.repeat(64)}`,
    },
  });
}

function baseline(baselineId, captureIdentity, mediaSha256) {
  const identityKey = visualBaselineIdentityKey(captureIdentity);
  const slotKey = visualBaselineSlotKey(captureIdentity);
  return {
    schemaVersion: 1,
    baselineId,
    identityKey,
    slotKey,
    identity: captureIdentity,
    state: 'active',
    source: {},
    media: { relativePath: `media/${baselineId}.png`, sha256: mediaSha256, bytes: 8, available: true },
    approvedBy: 'fixture-reviewer',
    approvedAt: '2026-08-25T12:00:00.000Z',
    replacedBy: null,
    revokedAt: null,
    deletedAt: null,
    deletionReason: null,
  };
}

async function expectCode(operation, statusCode, code) {
  await assert.rejects(operation, (error) => {
    assert(error instanceof SingleSiteGalleryError);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-gallery-api-'));
try {
  const jobId = 'job-gallery-fixture';
  const attemptId = 'attempt-gallery-fixture';
  const jobRoot = path.join(temporary, jobId);
  const reportRoot = path.join(jobRoot, 'report');
  const visualRoot = path.join(jobRoot, 'visual');
  const indexRoot = path.join(reportRoot, 'checklist', 'single-site-gallery-index');
  await fs.mkdir(path.join(indexRoot, 'revisions'), { recursive: true });
  await fs.mkdir(path.join(visualRoot, 'diffs'), { recursive: true });
  await fs.mkdir(path.join(reportRoot, 'raw'), { recursive: true });

  const itemIds = ['gitem_0000000000000001', 'gitem_0000000000000002', 'gitem_0000000000000003'];
  const bytes = [Buffer.from('current-one'), Buffer.from('video-two'), Buffer.from('current-three')];
  const currentDigests = bytes.map((value) => visualBaselineDigest(value));
  await Promise.all(bytes.map((value, index) => fs.writeFile(path.join(reportRoot, 'raw', `${index + 1}.bin`), value)));
  const diffBytes = [Buffer.from('diff-one'), Buffer.from('diff-three')];
  const visualItemIds = ['1'.repeat(32), '3'.repeat(32)];
  await Promise.all(diffBytes.map((value, index) => fs.writeFile(path.join(visualRoot, 'diffs', `${visualItemIds[index]}.png`), value)));

  const exportRevision = `export_${'d'.repeat(16)}`;
  const entries = [
    { itemId: itemIds[0], auditCaseId: 'NAV-001.desktop.home', auditIds: ['NAV-001'], sourceTestId: 'tests/nav.spec.ts::home', projectName: 'single-site-desktop-chromium', kind: 'image', status: 'passed' },
    { itemId: itemIds[1], auditCaseId: null, auditIds: ['VIDEO-001'], sourceTestId: 'tests/video.spec.ts::menu', projectName: 'single-site-desktop-chromium', kind: 'video', status: 'passed' },
    { itemId: itemIds[2], auditCaseId: 'LAYOUT-001.desktop.card', auditIds: ['LAYOUT-001'], sourceTestId: 'tests/layout.spec.ts::card', projectName: 'single-site-desktop-chromium', kind: 'image', status: 'passed' },
  ];
  const { indexBody, indexDigest, indexDocument, indexFile } = await writePagedCaseIndex({
    reportRoot, exportRevision, entries, pageRows: 2,
  });

  const firstIdentity = identity('/', 'NAV-001', 'home-loaded');
  const thirdIdentity = identity('/cards/', 'LAYOUT-001', 'card-loaded');
  const firstBaseline = baseline('baseline-first', firstIdentity, `sha256:${'e'.repeat(64)}`);
  const replacementBaseline = baseline('baseline-replacement', thirdIdentity, `sha256:${'f'.repeat(64)}`);
  const oldThirdBaseline = baseline('baseline-old-third', thirdIdentity, `sha256:${'0'.repeat(64)}`);
  oldThirdBaseline.state = 'replaced';
  oldThirdBaseline.replacedBy = replacementBaseline.baselineId;

  const visualItems = [
    {
      schemaVersion: 1, itemId: visualItemIds[0], executionId: 'execution-one', caseId: 'NAV-001.desktop.home', auditId: 'NAV-001',
      targetId: firstIdentity.targetId, identity: firstIdentity, identityKey: firstBaseline.identityKey, slotKey: firstBaseline.slotKey,
      current: { relativePath: 'raw/1.bin', bytes: bytes[0].length, sha256: currentDigests[0] },
      baseline: { baselineId: firstBaseline.baselineId, identityKey: firstBaseline.identityKey, slotKey: firstBaseline.slotKey, approvedAt: firstBaseline.approvedAt, mediaSha256: firstBaseline.media.sha256 },
      compatibility: { compatible: true, differences: [] },
      comparison: { schemaVersion: 1, status: 'CHANGED', comparisonStatus: 'CHANGED', differingPixels: 5, totalPixels: 10, differingPixelRatio: 0.5, reason: 'Fixture changed.', review: null },
      diff: { relativePath: `diffs/${visualItemIds[0]}.png`, bytes: diffBytes[0].length, sha256: visualBaselineDigest(diffBytes[0]) },
    },
    {
      schemaVersion: 1, itemId: visualItemIds[1], executionId: 'execution-three', caseId: 'LAYOUT-001.desktop.card', auditId: 'LAYOUT-001',
      targetId: thirdIdentity.targetId, identity: thirdIdentity, identityKey: replacementBaseline.identityKey, slotKey: replacementBaseline.slotKey,
      current: { relativePath: 'raw/3.bin', bytes: bytes[2].length, sha256: currentDigests[2] },
      baseline: { baselineId: oldThirdBaseline.baselineId, identityKey: oldThirdBaseline.identityKey, slotKey: oldThirdBaseline.slotKey, approvedAt: oldThirdBaseline.approvedAt, mediaSha256: oldThirdBaseline.media.sha256 },
      compatibility: { compatible: true, differences: [] },
      comparison: { schemaVersion: 1, status: 'CHANGED', comparisonStatus: 'CHANGED', differingPixels: 2, totalPixels: 10, differingPixelRatio: 0.2, reason: 'Fixture changed against an old baseline.', review: null },
      diff: { relativePath: `diffs/${visualItemIds[1]}.png`, bytes: diffBytes[1].length, sha256: visualBaselineDigest(diffBytes[1]) },
    },
  ];
  const eligibilityBody = {
    schemaVersion: 1,
    kind: 'single-site-visual-baseline-eligibility',
    mode: 'single-site',
    jobId,
    attemptId,
    finalizationDigest: '1'.repeat(64),
    reportRevision: '2'.repeat(32),
    generatedAt: '2026-08-25T12:00:00.000Z',
    items: visualItems.map((item) => ({
      evidenceId: visualBaselineDigest([jobId, item.itemId]), identity: item.identity, identityKey: item.identityKey, slotKey: item.slotKey,
      evidence: { artifactSha256: item.current.sha256, findingStatus: 'clear' },
      requiresFindingWaiver: false, eligible: true, ineligibilityReasons: [],
    })),
  };
  const eligibility = { ...eligibilityBody, manifestDigest: visualBaselineDigest(eligibilityBody) };
  await fs.writeFile(path.join(visualRoot, 'eligibility.json'), `${JSON.stringify(eligibility)}\n`);
  const visualPublication = {
    schemaVersion: 1,
    kind: 'single-site-visual-comparison-publication',
    mode: 'single-site',
    runId: jobId,
    publicationDigest: `sha256:${'3'.repeat(64)}`,
    items: visualItems,
  };
  const bindings = {
    jobId, attemptId, status: 'complete', executionState: 'completed',
    finalizationDigest: eligibility.finalizationDigest,
    reportRevision: eligibility.reportRevision,
    reportPublicationDigest: '4'.repeat(64),
    visualPublicationDigest: visualPublication.publicationDigest,
    visualEligibilityManifestDigest: eligibility.manifestDigest,
    galleryPublicationDigest: '5'.repeat(64),
    galleryExportRevision: exportRevision,
    galleryIndexDigest: indexDigest,
  };
  const rows = entries.map((entry, index) => ({
    id: entry.itemId,
    kind: entry.kind,
    title: `Evidence ${index + 1}`,
    projectName: entry.projectName,
    primaryFeatureSuite: entry.auditIds[0],
    technicalSuite: 'fixture',
    auditAssociations: entry.auditIds.map((id) => ({ id, title: id })),
  }));
  const details = new Map(entries.map((entry, index) => [entry.itemId, {
    schemaVersion: 1,
    item: {
      id: entry.itemId, kind: entry.kind, test: { id: entry.sourceTestId, technicalSuite: 'fixture' },
      project: { name: entry.projectName, browser: 'chromium', deviceClass: 'desktop' },
      attempt: { status: entry.status, ordinal: 1 },
      members: [{ id: `member-${index}`, role: 'single' }],
      auditAssociations: entry.auditIds.map((id) => ({ id, title: id })),
      capture: { route: index === 0 ? '/' : index === 1 ? '/menu/' : '/cards/', observedState: 'loaded', rationale: 'fixture' },
    },
    media: [{
      memberId: `member-${index}`,
      href: `/artifacts/${jobId}/raw/${index + 1}.bin`,
      contentType: entry.kind === 'image' ? 'image/png' : 'video/webm',
      sizeBytes: bytes[index].length,
      sha256: currentDigests[index],
      available: true,
    }],
  }]));
  const baselineState = {
    schemaVersion: 1,
    storeRevision: 19,
    historyDigest: `sha256:${'6'.repeat(64)}`,
    baselines: Object.fromEntries([firstBaseline, oldThirdBaseline, replacementBaseline].map((record) => [record.baselineId, record])),
    activeBySlot: { [firstBaseline.slotKey]: firstBaseline.baselineId, [replacementBaseline.slotKey]: replacementBaseline.baselineId },
    idempotency: {},
  };
  const reportPublication = {
    mode: 'single-site', publicationRevision: bindings.reportRevision,
    publicationDigest: bindings.reportPublicationDigest, generatedAt: '2026-08-25T12:00:00.000Z',
  };
  const report = {
    summary: {},
    audits: new Map([
      ['NAV-001', { id: 'NAV-001', title: 'Navigation', area: 'Navigation', status: 'PASS', findingCount: 0, evidenceStatus: 'complete' }],
      ['VIDEO-001', { id: 'VIDEO-001', title: 'Menu interaction', area: 'Interactions', status: 'PASS', findingCount: 0, evidenceStatus: 'complete' }],
      ['LAYOUT-001', { id: 'LAYOUT-001', title: 'Card layout', area: 'Layout', status: 'PASS', findingCount: 0, evidenceStatus: 'complete' }],
    ]),
    coverageGapsByAudit: new Map(),
    coverageWithoutAudit: [],
    definitions: new Map([
      ['NAV-001', { id: 'NAV-001', title: 'Navigation', area: 'Navigation', severity: 'P1' }],
      ['VIDEO-001', { id: 'VIDEO-001', title: 'Menu interaction', area: 'Interactions', severity: 'P2' }],
      ['LAYOUT-001', { id: 'LAYOUT-001', title: 'Card layout', area: 'Layout', severity: 'P2' }],
    ]),
  };
  let galleryLoadOptions = null;
  const dependencies = {
    loadGallerySnapshot: async (_run, _signal, options) => {
      galleryLoadOptions = options;
      return ({
      kind: 'sealed', rows: options.includeRows === false ? [] : rows,
      head: { phase: 'sealed', exportRevision, primaryCounts: { total: 3, images: 2, videos: 1 }, facets: { featureSuites: ['Interactions', 'Layout', 'Navigation'], technicalSuites: ['fixture'], kinds: ['image', 'video'] } },
    });
    },
    readGalleryItem: async (_gallery, _runId, itemId) => structuredClone(details.get(itemId)),
    readVisualPublication: async () => visualPublication,
    readBaselineStore: async () => ({ state: baselineState, history: [] }),
    loadReportContext: async () => report,
  };

  const snapshot = await openSingleSiteGallery({
    finalizationRoot: temporary, jobId, attemptId, bindings, baselineStore: {}, reportPublication, dependencies,
  });
  const head = singleSiteGalleryHead(snapshot);
  assert.deepEqual(galleryLoadOptions, { includeRows: false },
    'Opening a Single-site gallery must load only the sealed gallery head, never all query rows.');
  assert.equal(head.sourceWork.galleryFullInventoryLoaded, false);
  assert.equal(head.sourceWork.galleryDetailReads, 0);
  assert.deepEqual(head.caseMapping, { known: 2, unknown: 1, source: 'digest-bound-gallery-index' });
  assert.equal(head.galleryIndexDigest, indexDigest);
  assert.equal(head.baselineStoreRevision, 19);

  const v2PointerFile = path.join(indexRoot, 'current.json');
  const v2PointerSource = await fs.readFile(v2PointerFile, 'utf8');
  const legacyIndexBody = {
    schemaVersion: 1,
    kind: 'single-site-gallery-index',
    mode: 'single-site',
    generatedAt: '2026-08-25T12:00:00.000Z',
    exportRevision,
    entries,
  };
  const legacyIndexDigest = bareDigest(legacyIndexBody);
  const legacyRelativePath = `single-site-gallery-index/revisions/${legacyIndexDigest}.json`;
  await fs.writeFile(path.join(reportRoot, 'checklist', ...legacyRelativePath.split('/')), `${JSON.stringify({
    ...legacyIndexBody, indexDigest: legacyIndexDigest,
  })}\n`);
  await fs.writeFile(v2PointerFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'single-site-gallery-index-pointer',
    indexDigest: legacyIndexDigest,
    exportRevision,
    relativePath: legacyRelativePath,
    itemCount: entries.length,
  })}\n`);
  const legacySnapshot = await openSingleSiteGallery({
    finalizationRoot: temporary, jobId, attemptId,
    bindings: { ...bindings, galleryIndexDigest: legacyIndexDigest },
    baselineStore: {}, reportPublication, dependencies,
  });
  assert.equal(singleSiteGalleryHead(legacySnapshot).sourceWork.galleryInventoryRowsRead, 0,
    'A retained v1 gallery index must remain deferred at snapshot open.');
  assert.deepEqual(singleSiteGalleryHead(legacySnapshot).caseMapping, {
    known: null, unknown: null, source: 'legacy-index-deferred',
  });
  const legacyPage = await pageSingleSiteGalleryItems(legacySnapshot, { offset: 0, limit: 1 });
  assert.equal(legacyPage.items.length, 1);
  assert.equal(legacyPage.sourceWork.galleryInventoryRowsRead, entries.length);
  assert.equal(legacyPage.sourceWork.galleryFullInventoryLoaded, true,
    'A legacy monolithic read must be disclosed rather than misreported as bounded work.');
  await fs.writeFile(v2PointerFile, v2PointerSource);

  const scaleJobId = 'job-gallery-reference-scale';
  const scaleAttemptId = 'attempt-gallery-reference-scale';
  const scaleJobRoot = path.join(temporary, scaleJobId);
  const scaleReportRoot = path.join(scaleJobRoot, 'report');
  const scaleVisualRoot = path.join(scaleJobRoot, 'visual');
  await fs.mkdir(path.join(scaleReportRoot, 'checklist', 'single-site-gallery-index', 'revisions'), { recursive: true });
  await fs.mkdir(scaleVisualRoot, { recursive: true });
  const scaleEntries = Array.from({ length: 10_000 }, (_, index) => ({
    itemId: `gitem_${index.toString(16).padStart(16, '0')}`,
    auditCaseId: `SCALE-001.case-${index}`,
    auditIds: ['SCALE-001'],
    sourceTestId: `tests/scale.spec.ts::case-${index}`,
    projectName: 'single-site-desktop-chromium',
    kind: 'video',
    status: 'passed',
  }));
  const scaleIndex = await writePagedCaseIndex({
    reportRoot: scaleReportRoot, exportRevision, entries: scaleEntries, pageRows: 100,
  });
  const scaleEligibilityBody = {
    schemaVersion: 1,
    kind: 'single-site-visual-baseline-eligibility',
    mode: 'single-site',
    jobId: scaleJobId,
    attemptId: scaleAttemptId,
    finalizationDigest: '7'.repeat(64),
    reportRevision: '8'.repeat(32),
    generatedAt: '2026-08-25T12:00:00.000Z',
    items: [],
  };
  const scaleEligibility = { ...scaleEligibilityBody, manifestDigest: visualBaselineDigest(scaleEligibilityBody) };
  await fs.writeFile(path.join(scaleVisualRoot, 'eligibility.json'), `${JSON.stringify(scaleEligibility)}\n`);
  const scaleVisualPublication = {
    schemaVersion: 1,
    kind: 'single-site-visual-comparison-publication',
    mode: 'single-site',
    runId: scaleJobId,
    publicationDigest: `sha256:${'9'.repeat(64)}`,
    items: [],
  };
  const scaleBindings = {
    jobId: scaleJobId,
    attemptId: scaleAttemptId,
    status: 'complete',
    executionState: 'completed',
    finalizationDigest: scaleEligibility.finalizationDigest,
    reportRevision: scaleEligibility.reportRevision,
    reportPublicationDigest: 'a'.repeat(64),
    visualPublicationDigest: scaleVisualPublication.publicationDigest,
    visualEligibilityManifestDigest: scaleEligibility.manifestDigest,
    galleryPublicationDigest: 'b'.repeat(64),
    galleryExportRevision: exportRevision,
    galleryIndexDigest: scaleIndex.indexDigest,
  };
  const scaleReportPublication = {
    mode: 'single-site',
    publicationRevision: scaleBindings.reportRevision,
    publicationDigest: scaleBindings.reportPublicationDigest,
    generatedAt: '2026-08-25T12:00:00.000Z',
  };
  const scaleReport = {
    ...report,
    audits: new Map([['SCALE-001', {
      id: 'SCALE-001', title: 'Scale audit', area: 'Scale', status: 'PASS', findingCount: 0, evidenceStatus: 'complete',
    }]]),
    coverageGapsByAudit: new Map(),
    definitions: new Map([['SCALE-001', { id: 'SCALE-001', title: 'Scale audit', area: 'Scale', severity: 'P3' }]]),
  };
  const scaleDependencies = {
    loadGallerySnapshot: async () => ({
      kind: 'sealed', rows: [],
      head: {
        phase: 'sealed', exportRevision,
        primaryCounts: { total: scaleEntries.length, images: 0, videos: scaleEntries.length },
        facets: { featureSuites: ['Scale'], technicalSuites: ['fixture'], kinds: ['video'] },
      },
    }),
    readGalleryItem: async (_gallery, _runId, itemId) => {
      const ordinal = Number.parseInt(itemId.slice('gitem_'.length), 16);
      const entry = scaleEntries[ordinal];
      return {
        schemaVersion: 1,
        item: {
          id: entry.itemId, kind: entry.kind,
          test: { id: entry.sourceTestId, technicalSuite: 'scale' },
          project: { name: entry.projectName, browser: 'chromium', deviceClass: 'desktop' },
          attempt: { status: entry.status, ordinal: 1 }, members: [],
          auditAssociations: [{ id: 'SCALE-001', title: 'Scale audit' }],
          capture: { route: `/case-${ordinal}/`, observedState: 'loaded', rationale: 'scale fixture' },
        },
        media: [],
      };
    },
    readVisualPublication: async () => scaleVisualPublication,
    readBaselineStore: async () => ({ state: { ...baselineState, storeRevision: 20 }, history: [] }),
    loadReportContext: async () => scaleReport,
  };
  const scaleSnapshot = await openSingleSiteGallery({
    finalizationRoot: temporary, jobId: scaleJobId, attemptId: scaleAttemptId, bindings: scaleBindings,
    baselineStore: {}, reportPublication: scaleReportPublication, dependencies: scaleDependencies,
  });
  assert.equal(singleSiteGalleryHead(scaleSnapshot).sourceWork.galleryInventoryRowsRead, 0,
    'Reference-scale gallery head must not read a case-index page.');
  const scaleFirstPage = await pageSingleSiteGalleryItems(scaleSnapshot, { offset: 0, limit: 50 });
  assert.equal(scaleFirstPage.items.length, 50);
  assert.equal(scaleFirstPage.sourceWork.galleryInventoryRowsRead, 100,
    'Reference-scale first page must read only its bounded digest-bound case-index page.');
  assert.equal(scaleFirstPage.sourceWork.galleryFullInventoryLoaded, false);
  const deepItemId = scaleEntries[9_876].itemId;
  const deepAnchorSnapshot = await openSingleSiteGallery({
    finalizationRoot: temporary, jobId: scaleJobId, attemptId: scaleAttemptId, bindings: scaleBindings,
    baselineStore: {}, reportPublication: scaleReportPublication, dependencies: scaleDependencies,
  });
  const deepAnchorPage = await pageSingleSiteGalleryItems(deepAnchorSnapshot, {
    anchorItemId: deepItemId, limit: 5,
  });
  assert(deepAnchorPage.items.some(({ itemId }) => itemId === deepItemId));
  assert.equal(deepAnchorPage.queuePosition.sourceOrdinal, 9_877);
  assert(deepAnchorPage.sourceWork.galleryInventoryRowsRead <= 200,
    'A deep anchor plus bounded context must not read preceding case-index pages.');
  assert.equal(deepAnchorPage.sourceWork.galleryFullInventoryLoaded, false);
  const deepScaleSnapshot = await openSingleSiteGallery({
    finalizationRoot: temporary, jobId: scaleJobId, attemptId: scaleAttemptId, bindings: scaleBindings,
    baselineStore: {}, reportPublication: scaleReportPublication, dependencies: scaleDependencies,
  });
  const deepItem = await readSingleSiteGalleryItem(deepScaleSnapshot, deepItemId);
  assert.equal(deepItem.item.itemId, deepItemId);
  assert.equal(deepItem.sourceWork.galleryInventoryRowsRead, 100,
    'A deep-linked detail must resolve from one authenticated page without reading preceding pages.');
  assert.equal(deepItem.sourceWork.galleryFullInventoryLoaded, false);

  const productionAudits = [
    ...Array.from({ length: 249 }, (_, index) => ({
      id: `AUD-${String(index).padStart(3, '0')}`,
      title: `Audit ${index}`,
      area: 'Scale',
      status: 'PASS',
      findingCount: 0,
      evidenceStatus: 'complete',
      artifactCount: 0,
      manual: false,
      visualStatus: 'UNCHANGED',
      detail: 'Bounded report lookup fixture.',
    })),
    {
      id: 'NAV-001', title: 'Navigation', area: 'Navigation', status: 'FAIL', findingCount: 1,
      evidenceStatus: 'complete', artifactCount: 1, manual: false, visualStatus: 'CHANGED',
      detail: 'Navigation finding fixture.',
    },
  ];
  const productionDocuments = buildSingleSiteReportDocuments({
    schemaVersion: 1,
    mode: 'single-site',
    generatedAt: reportPublication.generatedAt,
    pageSize: 10,
    health: {
      schemaVersion: 1, mode: 'single-site', url: 'https://preview.example', deploymentRole: 'preview',
      scope: { qualifier: 'FULL', selectedCoverage: productionAudits.map(({ id }) => id), omittedCoverage: [] },
      coverage: {
        finalized: true, manifestIntegrity: true,
        gaps: Array.from({ length: 150 }, (_, index) => `NAV-001 bounded coverage gap ${index}.`),
        limitations: [],
      },
      pipeline: { executionStatus: 'completed', integrityComplete: true, requiredEvidenceComplete: true, reason: 'Complete.', cancellationReason: null },
      evidenceAuthority: { status: 'authoritative', reasons: [] },
      findings: [{ id: 'finding-navigation', severity: 'P1' }],
      manual: { required: 0, complete: 0, failedOrBlocked: 0 },
      visualReview: { items: [{ status: 'CHANGED' }] },
    },
    audits: productionAudits,
    outsideMode: [],
  }, { publicationRevision: bindings.reportRevision }).documents;
  let productionReportReads = 0;
  const productionSnapshot = await openSingleSiteGallery({
    finalizationRoot: temporary,
    jobId,
    attemptId,
    bindings,
    baselineStore: {},
    reportPublication,
    dependencies: {
      ...dependencies,
      loadReportContext: undefined,
      readPublishedReportJson: async (_publication, relativePath) => {
        productionReportReads += 1;
        return { document: structuredClone(productionDocuments.get(relativePath)) };
      },
    },
  });
  assert.equal(singleSiteGalleryHead(productionSnapshot).sourceWork.reportDocumentsRead, 1,
    'The production report context must read only summary.json for the gallery head.');
  const productionPage = await pageSingleSiteGalleryItems(productionSnapshot, { offset: 0, limit: 1 });
  assert.equal(productionPage.items.length, 1);
  assert(productionPage.sourceWork.reportDocumentsRead < 8,
    'One bounded page must use lazy binary audit lookup rather than reading all 25 audit pages.');
  assert.equal(productionReportReads, productionPage.sourceWork.reportDocumentsRead);
  assert.equal(productionPage.sourceWork.galleryDetailReads, 1);

  const page = await pageSingleSiteGalleryItems(snapshot, { offset: 0, limit: 2, revision: bindings.reportRevision });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 2);
  assert.equal(page.items[0].caseId, 'NAV-001.desktop.home');
  assert.equal(page.items[0].caseIdSource, 'digest-bound-gallery-index');
  assert.equal(page.items[0].attentionRequired, true);
  assert.equal(page.items[1].caseId, 'unknown');
  assert.equal(page.items[1].visualReviewStatus, 'absent');
  assert.equal(page.items[1].attentionRequired, false);
  assert.equal(page.sourceWork.galleryDetailReads, 2,
    'A page must read detail only for its bounded scanned rows.');

  const anchoredPage = await pageSingleSiteGalleryItems(snapshot, {
    anchorItemId: itemIds[2],
    limit: 1,
    revision: bindings.reportRevision,
    baselineStoreRevision: 19,
    reviewRevision: 0,
  });
  assert.deepEqual(anchoredPage.items.map(({ itemId }) => itemId), [itemIds[2]]);
  assert.deepEqual(anchoredPage.queuePosition, {
    itemId: itemIds[2], sourceOrdinal: 3, sourceTotal: 3, pageOrdinal: 1,
  });
  assert.equal(anchoredPage.anchorExcluded, false);
  const attentionPage = await pageSingleSiteGalleryItems(snapshot, {
    offset: 0, limit: 100, revision: bindings.reportRevision, scope: 'attention',
  });
  assert.deepEqual(attentionPage.items.map(({ itemId }) => itemId), [itemIds[0], itemIds[2]]);
  assert.equal(attentionPage.filteredTotal, 2);
  assert.deepEqual(attentionPage.scan, { offset: 0, nextOffset: 3, rows: 3, complete: true });
  const excludedAnchorPage = await pageSingleSiteGalleryItems(snapshot, {
    anchorItemId: itemIds[1], limit: 2, revision: bindings.reportRevision, scope: 'attention',
  });
  assert.equal(excludedAnchorPage.items.some(({ itemId }) => itemId === itemIds[1]), true);
  assert.equal(excludedAnchorPage.anchorExcluded, true);
  assert.equal(excludedAnchorPage.items.length <= 2, true);
  await expectCode(() => pageSingleSiteGalleryItems(snapshot, {
    anchorItemId: itemIds[2], limit: 1, revision: bindings.reportRevision, baselineStoreRevision: 18,
  }), 409, 'SINGLE_SITE_GALLERY_REVISION_STALE');
  await expectCode(() => pageSingleSiteGalleryItems(snapshot, {
    anchorItemId: itemIds[2], limit: 1, revision: bindings.reportRevision, reviewRevision: 1,
  }), 409, 'SINGLE_SITE_GALLERY_REVISION_STALE');

  const first = (await readSingleSiteGalleryItem(snapshot, itemIds[0])).item;
  assert.equal(first.urls.diff, `/api/single-site/runs/${jobId}/gallery/items/${itemIds[0]}/media/diff`);
  assert.equal(first.baseline.baselineId, firstBaseline.baselineId);
  const stale = (await readSingleSiteGalleryItem(snapshot, itemIds[2])).item;
  assert.equal(stale.visualReviewStatus, 'unavailable');
  assert.equal(stale.staleComparisonWithheld, true);
  assert.equal(stale.urls.diff, null);
  assert.equal(stale.baseline.baselineId, replacementBaseline.baselineId);
  await expectCode(() => readSingleSiteGalleryItem(snapshot, itemIds[0], {
    revision: bindings.reportRevision, baselineStoreRevision: 18,
  }), 409, 'SINGLE_SITE_GALLERY_REVISION_STALE');

  const requests = [];
  const requestJson = async (url, options) => {
    requests.push({ url, options });
    return { items: [] };
  };
  const singleSiteSource = createLiveGalleryDataSource({ mode: 'single-site', runId: jobId, requestJson });
  const signalController = new AbortController();
  await singleSiteSource.loadItems({
    offset: 50,
    limit: 25,
    anchorItemId: itemIds[2],
    publicationRevision: bindings.reportRevision,
    baselineStoreRevision: 19,
    reviewRevision: 0,
    filters: { scope: 'attention', kind: 'image', suite: 'Navigation', finding: 'finding', coverage: 'gap', visual: 'CHANGED', query: 'header' },
    signal: signalController.signal,
  });
  const singleSiteUrl = new URL(requests.at(-1).url, 'http://portal.invalid');
  assert.equal(singleSiteSource.mode, 'single-site');
  assert.equal(singleSiteUrl.pathname, `/api/single-site/runs/${jobId}/gallery/items`);
  assert.deepEqual(Object.fromEntries(singleSiteUrl.searchParams), {
    offset: '50', limit: '25', revision: bindings.reportRevision, baselineStoreRevision: '19', reviewRevision: '0',
    scope: 'attention', kind: 'image', suite: 'Navigation', finding: 'finding', coverage: 'gap', visual: 'CHANGED',
    q: 'header', anchor: itemIds[2],
  });
  assert.equal(requests.at(-1).options.signal, signalController.signal);
  const comparativeSource = createLiveGalleryDataSource({ mode: 'comparative', runId: jobId, requestJson });
  await comparativeSource.loadItems({
    limit: 10, anchorItemId: itemIds[0], contentRevision: 'content_1111111111111111',
    orderRevision: 'order_2222222222222222', flagRevision: 'flags_3333333333333333',
    query: { kinds: ['image'], search: 'navigation' }, signal: signalController.signal,
  });
  const comparativeUrl = new URL(requests.at(-1).url, 'http://portal.invalid');
  assert.equal(comparativeSource.mode, 'comparative');
  assert.equal(comparativeUrl.pathname, `/api/runs/${jobId}/gallery/items`);
  assert.equal(comparativeUrl.searchParams.get('anchor'), itemIds[0]);
  assert.equal(comparativeUrl.searchParams.get('contentRevision'), 'content_1111111111111111');
  assert.deepEqual(comparativeUrl.searchParams.getAll('kind'), ['image']);
  assert.throws(() => createLiveGalleryDataSource({ mode: 'unknown', runId: jobId, requestJson }), /mode/);

  const currentMedia = await resolveSingleSiteGalleryMedia(snapshot, itemIds[0], 'current');
  const diffMedia = await resolveSingleSiteGalleryMedia(snapshot, itemIds[0], 'diff');
  assert.equal(currentMedia.sha256, currentDigests[0]);
  assert.equal(diffMedia.sha256, visualBaselineDigest(diffBytes[0]));
  assert.equal(await fs.readFile(currentMedia.absolutePath, 'utf8'), 'current-one');
  assert(!JSON.stringify({ head, page, first, currentMedia, diffMedia }).includes(temporary));
  assert(!Object.keys(currentMedia).includes('absolutePath'));
  assert(!Object.keys(currentMedia).includes('opened'));
  await currentMedia.opened.handle.close();
  await diffMedia.opened.handle.close();
  await expectCode(() => resolveSingleSiteGalleryMedia(snapshot, itemIds[2], 'diff'), 404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND');
  await expectCode(() => pageSingleSiteGalleryItems(snapshot, { limit: 101 }), 400, 'SINGLE_SITE_GALLERY_PAGE_INVALID');

  const originalHref = details.get(itemIds[0]).media[0].href;
  details.get(itemIds[0]).media[0].href = `/artifacts/${jobId}/../outside.png`;
  await expectCode(() => resolveSingleSiteGalleryMedia(snapshot, itemIds[0], 'current'), 404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND');
  details.get(itemIds[0]).media[0].href = originalHref;

  const firstIndexPageFile = path.join(path.dirname(indexFile), ...indexDocument.pages[0].relativePath.split('/'));
  const firstIndexPageSource = await fs.readFile(firstIndexPageFile, 'utf8');
  const firstIndexPage = JSON.parse(firstIndexPageSource);
  firstIndexPage.entries[0].sourceTestId = 'tampered-test';
  await fs.writeFile(firstIndexPageFile, `${JSON.stringify(firstIndexPage)}\n`);
  const pageTamperSnapshot = await openSingleSiteGallery({
    finalizationRoot: temporary, jobId, attemptId, bindings, baselineStore: {}, reportPublication, dependencies,
  });
  await expectCode(() => pageSingleSiteGalleryItems(pageTamperSnapshot, { offset: 0, limit: 1 }), 500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID');
  await fs.writeFile(firstIndexPageFile, firstIndexPageSource);

  await fs.writeFile(indexFile, `${JSON.stringify({ ...indexDocument, generatedAt: '2026-08-25T12:00:01.000Z' })}\n`);
  await expectCode(() => openSingleSiteGallery({
    finalizationRoot: temporary, jobId, attemptId, bindings, baselineStore: {}, reportPublication, dependencies,
  }), 500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID');

  process.stdout.write('single-site gallery API self-test passed\n');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
