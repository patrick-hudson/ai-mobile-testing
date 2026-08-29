import { constants as fsConstants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import {
  expectedSingleSiteReportPaths,
  parseSingleSiteReportPage,
  parseSingleSiteReportSummary,
} from '../scripts/lib/site-health-report.mjs';
import { openParentRunStore, readCurrentEnvelope } from '../scripts/lib/parent-run-store.mjs';
import { projectPublicationView } from '../shared/release-projection.mjs';

export { projectPublicationView as projectReportReleasePublication } from '../shared/release-projection.mjs';

const REVISION_PATTERN = /^[a-f0-9]{32}$/;
const REPORT_PATH_PATTERN = /^(?:summary\.json|audits\.json|audits\/[A-Z0-9-]{3,160}\.json|(?:audits|coverage|scope\/(?:selected|omitted|outside-mode))\/page-\d{6}\.json)$/;

// Shared release publications are read from the store's single current head.
// Existing compact report publications remain available through the legacy
// readers below and cannot be mistaken for shared release authority.
export async function loadSharedReleasePublication(storeRoot, runId, options = {}) {
  const store = await openParentRunStore({
    root: storeRoot,
    filesystem: options.filesystem,
    verifyStorage: options.verifyStorage ?? false,
    storeMarker: options.storeMarker,
    expectedStoreGeneration: options.expectedStoreGeneration,
    writerProtocol: options.writerProtocol,
    buildIdentity: options.buildIdentity,
  });
  return readCurrentEnvelope(store, runId);
}

export async function loadSharedReleaseProjection(storeRoot, runId, options = {}) {
  return projectPublicationView(await loadSharedReleasePublication(storeRoot, runId, options));
}

export async function loadReportPublication(runDirectoryValue, requestedRevision = null, options = {}) {
  const runDirectory = resolve(runDirectoryValue);
  const dataDirectory = join(runDirectory, 'checklist', 'data');
  const maximumPointerBytes = options.maximumPointerBytes ?? 1024 * 1024;
  if (requestedRevision !== null && !REVISION_PATTERN.test(requestedRevision)) {
    throw new Error('Compact report publication revision is invalid.');
  }
  const pointerPath = requestedRevision === null
    ? join(dataDirectory, 'current.json')
    : join(dataDirectory, 'revisions', requestedRevision, 'publication.json');
  const pointer = await readRegularContainedFile(dataDirectory, pointerPath, maximumPointerBytes);
  let document;
  try {
    document = JSON.parse(pointer.buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`Compact report publication pointer is invalid JSON: ${error.message}`);
  }
  validatePublicationDocument(document);
  if (requestedRevision !== null && document.publicationRevision !== requestedRevision) {
    throw new Error('Compact report publication pointer names a different revision.');
  }
  const revisionDirectory = join(dataDirectory, 'revisions', document.publicationRevision);
  const revisionPointer = await readRegularContainedFile(
    dataDirectory,
    join(revisionDirectory, 'publication.json'),
    maximumPointerBytes,
  );
  if (revisionPointer.buffer.toString('utf8') !== pointer.buffer.toString('utf8')) {
    throw new Error('Compact report current pointer disagrees with its immutable revision manifest.');
  }
  return {
    runDirectory,
    dataDirectory,
    revisionDirectory,
    publicationRevision: document.publicationRevision,
    generatedAt: document.generatedAt,
    mode: document.mode === 'single-site' ? 'single-site' : 'comparative-legacy',
    kind: document.kind ?? 'comparative-report-publication',
    files: document.files,
    publicationDigest: createHash('sha256').update(pointer.buffer).digest('hex'),
  };
}

export async function loadComparativeReportPublication(runDirectoryValue, requestedRevision = null, options = {}) {
  const publication = await loadReportPublication(runDirectoryValue, requestedRevision, options);
  if (publication.mode === 'single-site') {
    throw new Error('Single-site Site Health publication cannot be read as a comparative release report.');
  }
  return publication;
}

export async function loadSingleSiteReportPublication(runDirectoryValue, requestedRevision = null, options = {}) {
  const publication = await loadReportPublication(runDirectoryValue, requestedRevision, options);
  if (publication.mode !== 'single-site') {
    throw new Error('Comparative release publication cannot be read as a Single-site Site Health report.');
  }
  return publication;
}

export async function readPublishedReportFile(publication, relativePath, maximumBytes) {
  if (!REPORT_PATH_PATTERN.test(relativePath)) throw new Error('Compact report path is invalid.');
  const expected = publication.files[relativePath];
  if (!expected) throw new Error(`Compact report publication does not declare ${relativePath}.`);
  if (expected.bytes > maximumBytes) {
    throw new Error(`Compact report file ${relativePath} exceeds its ${maximumBytes} byte safety limit.`);
  }
  const absolutePath = join(publication.revisionDirectory, ...relativePath.split('/'));
  const file = await readRegularContainedFile(publication.revisionDirectory, absolutePath, maximumBytes);
  if (file.bytes !== expected.bytes) {
    throw new Error(`Compact report file ${relativePath} byte count disagrees with its publication manifest.`);
  }
  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  if (sha256 !== expected.sha256) {
    throw new Error(`Compact report file ${relativePath} digest disagrees with its publication manifest.`);
  }
  return { ...file, sha256, path: absolutePath };
}

export async function readPublishedReportJson(publication, relativePath, maximumBytes) {
  const file = await readPublishedReportFile(publication, relativePath, maximumBytes);
  let document;
  try {
    document = JSON.parse(file.buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`Compact report file ${relativePath} is invalid JSON: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Compact report file ${relativePath} must contain a JSON object.`);
  }
  if (document.publicationRevision !== publication.publicationRevision) {
    throw new Error(`Compact report file ${relativePath} names a different publication revision.`);
  }
  if (document.generatedAt !== publication.generatedAt) {
    throw new Error(`Compact report file ${relativePath} names a different generation time.`);
  }
  if (publication.mode === 'single-site' && document.mode !== 'single-site') {
    throw new Error(`Compact report file ${relativePath} is missing its Single-site mode discriminator.`);
  }
  if (publication.mode !== 'single-site' && document.mode === 'single-site') {
    throw new Error(`Single-site compact report file ${relativePath} cannot be read through a comparative publication.`);
  }
  return { document, ...file };
}

export async function validateCompleteReportPublication(runDirectory, options = {}) {
  const problems = [];
  let publication;
  try {
    publication = await loadReportPublication(runDirectory, null, options);
  } catch (error) {
    return { problems: [error.message], publication: null, summary: null, audits: null };
  }
  let summary = null;
  let audits = null;
  try {
    summary = (await readPublishedReportJson(
      publication,
      'summary.json',
      options.maximumSummaryBytes ?? (publication.mode === 'single-site' ? 512 * 1024 : 2 * 1024 * 1024),
    )).document;
  } catch (error) {
    problems.push(error.message);
  }
  if (publication.mode === 'single-site') {
    return validateSingleSitePublication(publication, summary, problems, options);
  }
  try {
    audits = (await readPublishedReportJson(
      publication,
      'audits.json',
      options.maximumAuditIndexBytes ?? 16 * 1024 * 1024,
    )).document;
  } catch (error) {
    problems.push(error.message);
  }
  if (audits) {
    if (!Array.isArray(audits.items)) {
      problems.push('Compact report audits.json is missing its items array.');
    } else {
      if (audits.items.length === 0) problems.push('Compact report audits.json contains no audit rows.');
      if (!Number.isSafeInteger(summary?.summary?.total) || summary.summary.total !== audits.items.length) {
        problems.push('Compact report summary total disagrees with the published audit index.');
      }
      const ids = new Set();
      for (const [index, row] of audits.items.entries()) {
        const id = row?.id;
        if (typeof id !== 'string' || !/^[A-Z0-9-]{3,160}$/.test(id) || ids.has(id)) {
          problems.push(`Compact report audits.json item ${index} has an invalid or duplicate audit ID.`);
          continue;
        }
        ids.add(id);
        try {
          const detail = (await readPublishedReportJson(
            publication,
            `audits/${id}.json`,
            options.maximumAuditDetailBytes ?? 1024 * 1024,
          )).document;
          if (detail.id !== id) problems.push(`Compact report detail ${id} contains a different audit ID.`);
        } catch (error) {
          problems.push(error.message);
        }
      }
      const expectedPaths = new Set(['summary.json', 'audits.json', ...[...ids].map((id) => `audits/${id}.json`)]);
      for (const path of Object.keys(publication.files)) {
        if (!expectedPaths.has(path)) problems.push(`Compact report publication declares unexpected file ${path}.`);
      }
      for (const path of expectedPaths) {
        if (!publication.files[path]) problems.push(`Compact report publication is missing ${path}.`);
      }
    }
  }
  return { problems: [...new Set(problems)], publication, summary, audits };
}

async function validateSingleSitePublication(publication, summaryDocument, initialProblems, options) {
  const problems = [...initialProblems];
  let summary = null;
  if (summaryDocument) {
    try {
      summary = parseSingleSiteReportSummary(summaryDocument);
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (!summary) return { problems: [...new Set(problems)], publication, summary: null, audits: null };
  const expectedPaths = new Set(expectedSingleSiteReportPaths(summary));
  for (const path of Object.keys(publication.files)) {
    if (!expectedPaths.has(path)) problems.push(`Single-site compact report publication declares unexpected file ${path}.`);
  }
  for (const path of expectedPaths) {
    if (!publication.files[path]) problems.push(`Single-site compact report publication is missing ${path}.`);
  }
  const identifiers = {
    audits: new Set(),
    selected: new Set(),
    omitted: new Set(),
    outsideMode: new Set(),
  };
  let publishedFindingCount = 0;
  let publishedGapCount = 0;
  let publishedLimitationCount = 0;
  const publishedCoverage = [];
  const publishedOutsideMode = [];
  for (const path of [...expectedPaths].filter((value) => value !== 'summary.json').sort()) {
    if (!publication.files[path]) continue;
    try {
      const document = (await readPublishedReportJson(
        publication,
        path,
        options.maximumPageBytes ?? 512 * 1024,
      )).document;
      const page = parseSingleSiteReportPage(document, path, summary);
      if (path.startsWith('audits/')) {
        for (const item of page.items) {
          if (identifiers.audits.has(item.id)) problems.push(`Single-site audit row ${item.id} is duplicated across pages.`);
          identifiers.audits.add(item.id);
          publishedFindingCount += item.findingCount;
        }
      } else if (path.startsWith('scope/selected/')) {
        for (const item of page.items) {
          if (identifiers.selected.has(item)) problems.push(`Selected scope item ${item} is duplicated across pages.`);
          identifiers.selected.add(item);
        }
      } else if (path.startsWith('scope/omitted/')) {
        for (const item of page.items) {
          if (identifiers.omitted.has(item)) problems.push(`Omitted scope item ${item} is duplicated across pages.`);
          identifiers.omitted.add(item);
        }
      } else if (path.startsWith('scope/outside-mode/')) {
        for (const item of page.items) {
          publishedOutsideMode.push(item);
          if (identifiers.outsideMode.has(item.auditId)) problems.push(`Outside-mode item ${item.auditId} is duplicated across pages.`);
          identifiers.outsideMode.add(item.auditId);
        }
      } else if (path.startsWith('coverage/')) {
        for (const item of page.items) {
          publishedCoverage.push(item);
          if (item.kind === 'gap') publishedGapCount += 1;
          if (item.kind === 'limitation') publishedLimitationCount += 1;
        }
      }
    } catch (error) {
      problems.push(error.message);
    }
  }
  for (const item of identifiers.selected) {
    if (identifiers.omitted.has(item)) problems.push(`Coverage item ${item} is both selected and omitted.`);
  }
  if (JSON.stringify([...identifiers.selected].slice(0, 12)) !== JSON.stringify(summary.scope.selected.preview)) {
    problems.push('Single-site selected-scope preview disagrees with its paged source.');
  }
  if (JSON.stringify([...identifiers.omitted].slice(0, 12)) !== JSON.stringify(summary.scope.omitted.preview)) {
    problems.push('Single-site omitted-scope preview disagrees with its paged source.');
  }
  if (JSON.stringify(publishedOutsideMode.slice(0, 12)) !== JSON.stringify(summary.scope.outsideMode.preview)) {
    problems.push('Single-site outside-mode preview disagrees with its paged source.');
  }
  if (JSON.stringify(publishedCoverage.slice(0, 12)) !== JSON.stringify(summary.coverage.preview)) {
    problems.push('Single-site Coverage preview disagrees with its paged source.');
  }
  if (publishedFindingCount !== summary.findings.count) {
    problems.push('Single-site paged audit finding counts disagree with the compact summary.');
  }
  if (publishedGapCount !== summary.coverage.gapCount
    || publishedLimitationCount !== summary.coverage.limitationCount) {
    problems.push('Single-site paged Coverage details disagree with the compact summary.');
  }
  return { problems: [...new Set(problems)], publication, summary, audits: null };
}

function validatePublicationDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Compact report publication pointer must contain a JSON object.');
  }
  if (document.schemaVersion !== 1) throw new Error('Compact report publication schemaVersion must be 1.');
  if (document.mode !== undefined && document.mode !== 'single-site') {
    throw new Error('Compact report publication mode is invalid.');
  }
  if (document.mode === 'single-site' && document.kind !== 'single-site-report-publication') {
    throw new Error('Single-site compact report publication kind is invalid.');
  }
  if (document.mode === undefined && document.kind === 'single-site-report-publication') {
    throw new Error('Single-site compact report publication is missing its mode discriminator.');
  }
  if (document.mode === 'single-site') {
    const unexpected = Object.keys(document).filter((key) => ![
      'schemaVersion', 'kind', 'mode', 'publicationRevision', 'generatedAt', 'files',
    ].includes(key));
    if (unexpected.length > 0) {
      throw new Error(`Single-site compact report publication contains unknown fields: ${unexpected.sort().join(', ')}.`);
    }
  }
  if (!REVISION_PATTERN.test(document.publicationRevision ?? '')) {
    throw new Error('Compact report publication revision is invalid.');
  }
  if (!Number.isFinite(Date.parse(String(document.generatedAt ?? '')))) {
    throw new Error('Compact report publication generatedAt is invalid.');
  }
  if (!document.files || typeof document.files !== 'object' || Array.isArray(document.files)) {
    throw new Error('Compact report publication files map is invalid.');
  }
  for (const [path, record] of Object.entries(document.files)) {
    if (!REPORT_PATH_PATTERN.test(path)) throw new Error(`Compact report publication path ${path} is invalid.`);
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !Number.isSafeInteger(record.bytes) || record.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) {
      throw new Error(`Compact report publication record for ${path} is invalid.`);
    }
  }
}

async function readRegularContainedFile(rootDirectory, absolutePathValue, maximumBytes) {
  const absolutePath = resolve(absolutePathValue);
  if (!inside(rootDirectory, absolutePath) || absolutePath === rootDirectory) {
    throw new Error('Compact report file resolves outside its publication root.');
  }
  const linkStat = await fs.lstat(absolutePath).catch(() => null);
  if (!linkStat?.isFile() || linkStat.isSymbolicLink()) {
    throw new Error(`Compact report file ${relative(rootDirectory, absolutePath)} is missing or is not a regular file.`);
  }
  const [realRoot, realPath] = await Promise.all([fs.realpath(rootDirectory), fs.realpath(absolutePath)]);
  if (!inside(realRoot, realPath)) throw new Error('Compact report file resolves outside its publication root.');
  const handle = await fs.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) {
      throw new Error(`Compact report file ${relative(rootDirectory, absolutePath)} has an invalid size.`);
    }
    const buffer = await handle.readFile();
    return { buffer, bytes: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    await handle.close();
  }
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
