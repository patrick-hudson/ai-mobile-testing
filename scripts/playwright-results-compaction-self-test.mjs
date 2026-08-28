import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PlaywrightResultsCompactionError,
  compactPlaywrightResults,
  verifyStructuredEvidenceManifest,
  verifyStructuredEvidencePublication,
} from './lib/playwright-results-compaction.mjs';
import { sha256 } from './lib/job-queue.mjs';
import { inspectFreshPlaywrightEvidence } from './run-single-site-worker.mjs';

function attachment(name, bytes, contentType = 'application/json') {
  return { name, contentType, body: Buffer.from(bytes).toString('base64') };
}

function report(attachments) {
  return {
    config: { projects: [] },
    suites: [{
      title: 'bounded fixture',
      specs: [{
        title: 'oversized valid output',
        tests: [{
          annotations: [{ type: 'audit-case-id', description: 'ENV-002:fixture' }],
          expectedStatus: 'passed',
          projectName: 'single-site-desktop-chromium',
          status: 'expected',
          results: [{ status: 'passed', retry: 0, errors: [], attachments }],
        }],
      }],
      suites: [],
    }],
    errors: [],
  };
}

async function writeResults(root, value) {
  const file = path.join(root, 'results.json');
  await fs.writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  return file;
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => error instanceof PlaywrightResultsCompactionError && error.code === code);
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'playwright-results-compaction-'));
try {
  const largeBytes = Buffer.alloc(768 * 1_024, 0x61);
  const auditRecord = {
    schemaVersion: 1,
    mode: 'single-site',
    caseId: 'ENV-002:fixture',
    auditId: 'ENV-002',
    deploymentRole: 'preview',
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    environment: 'candidate',
    baseURL: 'https://beta.example.test',
    project: 'single-site-desktop-chromium',
    findings: [],
    steps: [{ name: 'Inspect', expected: 'Page is healthy.', kind: 'runtime-health', status: 'passed' }],
    observations: [],
    httpResponses: Array.from({ length: 1_000 }, (_, index) => ({ url: `https://beta.example.test/${index}`, status: 200 })),
  };
  const inlineAttachments = [
    attachment('audit-result', JSON.stringify(auditRecord)),
    ...Array.from({ length: 66 }, (_, index) => attachment(`large-evidence-${index}`, largeBytes)),
  ];
  const resultsPath = await writeResults(temporaryRoot, report(inlineAttachments));
  const before = await fs.stat(resultsPath);
  assert(before.size > 64 * 1_048_576, 'Fixture must reproduce an oversized but valid Playwright JSON report.');
  const fresh = await inspectFreshPlaywrightEvidence(temporaryRoot, Date.now() - 5_000);
  assert.equal(fresh.fresh, true, fresh.reason);
  assert.equal(fresh.sourceBytes, before.size);
  assert.equal(fresh.compacted, true);
  assert(fresh.bytes < 64 * 1_048_576);
  const compactBytes = await fs.readFile(resultsPath);
  const compactDocument = JSON.parse(compactBytes.toString('utf8'));
  const manifestBytes = await fs.readFile(path.join(temporaryRoot, fresh.structuredEvidence.relativePath));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.generatedSidecars, 67);
  assert.equal(manifest.items.length, 67);
  assert.equal(manifest.attachmentCount, 68, 'Original attachments plus the audit decision summary remain explicit.');
  const finalAttachments = compactDocument.suites[0].specs[0].tests[0].results[0].attachments;
  const preservedAudit = finalAttachments.find(({ name }) => name === 'audit-result');
  const summary = finalAttachments.find(({ name }) => name === 'audit-result-summary');
  assert.equal(typeof preservedAudit.path, 'string');
  assert.equal(preservedAudit.body, undefined);
  assert.equal(summary.contentType, 'application/json');
  const parsedSummary = JSON.parse(Buffer.from(summary.body, 'base64').toString('utf8'));
  assert.equal(parsedSummary.auditId, 'ENV-002');
  assert.equal(parsedSummary.httpResponses, undefined, 'Large diagnostic detail stays in the preserved original sidecar.');
  assert.equal(JSON.parse(await fs.readFile(path.join(temporaryRoot, preservedAudit.path), 'utf8')).httpResponses.length, 1_000);

  const binding = fresh.structuredEvidence;
  assert.equal(binding.digest, sha256(manifestBytes));
  assert.equal(verifyStructuredEvidenceManifest({ ...manifest, attachmentCount: manifest.attachmentCount + 1 }), false);
  await verifyStructuredEvidencePublication({ artifactRoot: temporaryRoot, resultsBytes: compactBytes, binding });
  await expectCode(
    () => verifyStructuredEvidencePublication({
      artifactRoot: temporaryRoot,
      resultsBytes: Buffer.concat([compactBytes, Buffer.from(' ')]),
      binding,
    }),
    'RESULTS_MANIFEST_RESULTS_MISMATCH',
  );
  await expectCode(
    () => verifyStructuredEvidencePublication({
      artifactRoot: temporaryRoot,
      resultsBytes: compactBytes,
      binding: { ...binding, itemCount: binding.itemCount + 1 },
    }),
    'RESULTS_MANIFEST_INVALID',
  );
  const firstItem = manifest.items[0];
  const firstPath = path.join(temporaryRoot, ...firstItem.relativePath.split('/'));
  const originalFirst = await fs.readFile(firstPath);
  await fs.writeFile(firstPath, Buffer.concat([originalFirst, Buffer.from('tamper')]));
  await expectCode(
    () => verifyStructuredEvidencePublication({ artifactRoot: temporaryRoot, resultsBytes: compactBytes, binding }),
    'RESULTS_MANIFEST_ITEM_CHANGED',
  );
  await fs.writeFile(firstPath, originalFirst);

  const reporterPathRoot = await fs.mkdtemp(path.join(temporaryRoot, 'reporter-path-'));
  const reporterAttachment = path.join(reporterPathRoot, 'raw', 'case', 'attachments', 'audit-result.json');
  await fs.mkdir(path.dirname(reporterAttachment), { recursive: true });
  await fs.writeFile(reporterAttachment, JSON.stringify(auditRecord));
  const reporterResultsPath = await writeResults(reporterPathRoot, report([{
    name: 'audit-result',
    contentType: 'application/json',
    path: reporterAttachment,
  }]));
  const reporterPublication = await compactPlaywrightResults({ artifactRoot: reporterPathRoot, resultsPath: reporterResultsPath });
  const reporterAttachments = reporterPublication.document.suites[0].specs[0].tests[0].results[0].attachments;
  assert.match(reporterAttachments[0].path, /^structured-evidence\/reporter-/);
  assert.equal(reporterAttachments[1].name, 'audit-result-summary');
  assert.equal(reporterPublication.manifest.items.length, 1);
  await verifyStructuredEvidencePublication({
    artifactRoot: reporterPathRoot,
    resultsBytes: reporterPublication.resultsBytes,
    binding: {
      relativePath: reporterPublication.manifestRelativePath,
      bytes: reporterPublication.manifestBytes.length,
      digest: sha256(reporterPublication.manifestBytes),
      manifestDigest: reporterPublication.manifest.manifestDigest,
      itemCount: reporterPublication.manifest.items.length,
      totalBytes: reporterPublication.manifest.structuredSidecarBytes,
    },
  });

  const reporterEscapeRoot = await fs.mkdtemp(path.join(temporaryRoot, 'reporter-path-escape-'));
  const reporterOutsideFile = path.join(temporaryRoot, 'outside-audit-result.json');
  await fs.writeFile(reporterOutsideFile, JSON.stringify(auditRecord));
  await writeResults(reporterEscapeRoot, report([{ name: 'audit-result', contentType: 'application/json', path: reporterOutsideFile }]));
  await expectCode(
    () => compactPlaywrightResults({ artifactRoot: reporterEscapeRoot, resultsPath: path.join(reporterEscapeRoot, 'results.json') }),
    'RESULTS_ATTACHMENT_PATH_ESCAPE',
  );

  const malformedRoot = await fs.mkdtemp(path.join(temporaryRoot, 'malformed-'));
  await writeResults(malformedRoot, '{"suites":[');
  await expectCode(
    () => compactPlaywrightResults({ artifactRoot: malformedRoot, resultsPath: path.join(malformedRoot, 'results.json') }),
    'RESULTS_JSON_MALFORMED',
  );

  const depthRoot = await fs.mkdtemp(path.join(temporaryRoot, 'depth-'));
  await writeResults(depthRoot, `${'['.repeat(65)}${']'.repeat(65)}`);
  await expectCode(
    () => compactPlaywrightResults({ artifactRoot: depthRoot, resultsPath: path.join(depthRoot, 'results.json') }),
    'RESULTS_JSON_DEPTH_EXCEEDED',
  );

  const base64Root = await fs.mkdtemp(path.join(temporaryRoot, 'base64-'));
  await writeResults(base64Root, report([{ name: 'invalid', contentType: 'application/json', body: '***not-base64***' }]));
  await expectCode(
    () => compactPlaywrightResults({ artifactRoot: base64Root, resultsPath: path.join(base64Root, 'results.json') }),
    'RESULTS_ATTACHMENT_BODY_INVALID',
  );

  const escapeRoot = await fs.mkdtemp(path.join(temporaryRoot, 'escape-'));
  await writeResults(escapeRoot, report([{ name: 'escaped', contentType: 'application/json', path: 'structured-evidence/../../escape.json' }]));
  await expectCode(
    () => compactPlaywrightResults({ artifactRoot: escapeRoot, resultsPath: path.join(escapeRoot, 'results.json') }),
    'RESULTS_ATTACHMENT_PATH_ESCAPE',
  );

  const siblingEscapeRoot = await fs.mkdtemp(path.join(temporaryRoot, 'sibling-escape-'));
  await writeResults(siblingEscapeRoot, report([{ name: 'escaped', contentType: 'application/json', path: 'structured-evidence/../results.json' }]));
  await expectCode(
    () => compactPlaywrightResults({ artifactRoot: siblingEscapeRoot, resultsPath: path.join(siblingEscapeRoot, 'results.json') }),
    'RESULTS_ATTACHMENT_PATH_ESCAPE',
  );

  const absoluteEscapeRoot = await fs.mkdtemp(path.join(temporaryRoot, 'absolute-escape-'));
  const absoluteSidecar = path.join(absoluteEscapeRoot, 'structured-evidence', 'absolute.json');
  await fs.mkdir(path.dirname(absoluteSidecar), { recursive: true });
  await fs.writeFile(absoluteSidecar, '{}');
  await writeResults(absoluteEscapeRoot, report([{ name: 'absolute', contentType: 'application/json', path: absoluteSidecar }]));
  await expectCode(
    () => compactPlaywrightResults({ artifactRoot: absoluteEscapeRoot, resultsPath: path.join(absoluteEscapeRoot, 'results.json') }),
    'RESULTS_ATTACHMENT_PATH_ESCAPE',
  );

  const symlinkRoot = await fs.mkdtemp(path.join(temporaryRoot, 'symlink-'));
  const symlinkTarget = path.join(symlinkRoot, 'sibling');
  await fs.mkdir(symlinkTarget);
  await fs.writeFile(path.join(symlinkTarget, 'evidence.json'), '{}');
  await fs.symlink(symlinkTarget, path.join(symlinkRoot, 'structured-evidence'));
  await writeResults(symlinkRoot, report([{ name: 'symlinked', contentType: 'application/json', path: 'structured-evidence/evidence.json' }]));
  await expectCode(
    () => compactPlaywrightResults({ artifactRoot: symlinkRoot, resultsPath: path.join(symlinkRoot, 'results.json') }),
    'RESULTS_ATTACHMENT_PATH_ESCAPE',
  );

  const sourceBombRoot = await fs.mkdtemp(path.join(temporaryRoot, 'source-bomb-'));
  await writeResults(sourceBombRoot, report([attachment('bounded', Buffer.alloc(2_048, 0x62))]));
  await expectCode(
    () => compactPlaywrightResults({
      artifactRoot: sourceBombRoot,
      resultsPath: path.join(sourceBombRoot, 'results.json'),
      limits: { maxSourceBytes: 1_024, maxCompactBytes: 512 },
    }),
    'RESULTS_SOURCE_OVERSIZED',
  );

  const bombRoot = await fs.mkdtemp(path.join(temporaryRoot, 'bomb-'));
  await writeResults(bombRoot, report([
    attachment('one', 'one'),
    attachment('two', 'two'),
    attachment('three', 'three'),
  ]));
  await expectCode(
    () => compactPlaywrightResults({
      artifactRoot: bombRoot,
      resultsPath: path.join(bombRoot, 'results.json'),
      limits: { maxAttachments: 2 },
    }),
    'RESULTS_STRUCTURE_BOMB',
  );

  process.stdout.write('Playwright results compaction self-test passed: oversized valid JSON is compacted with byte-preserving bound sidecars; malformed, deep, source-size, base64, absolute/dot-segment/symlink escape, count, manifest, and digest attacks fail closed.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
