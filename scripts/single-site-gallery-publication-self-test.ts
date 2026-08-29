import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishSingleSiteGallery } from './publish-single-site-gallery.js';
import { sharedPublicationFixture } from '../portal/tests/shared-publication-fixture.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-gallery-publication-'));
try {
  const artifactRoot = path.join(root, 'processed');
  const outputDir = path.join(root, 'report', 'checklist');
  const screenshot = path.join(artifactRoot, 'raw', 'home.png');
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await fs.writeFile(
    screenshot,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );
  const report = {
    config: {
      projects: [{
        id: 'single-site-mobile-chromium',
        name: 'single-site-mobile-chromium',
        metadata: {
          mode: 'single-site',
          environment: 'candidate',
          baseURL: 'https://beta.quitting7oh-org.pages.dev',
          browserLabel: 'Mobile Chromium',
          deviceClass: 'mobile',
          fullSweep: true,
          visual: true,
        },
      }],
    },
    suites: [{
      title: 'single-site gallery fixture',
      file: 'tests/smoke.spec.ts',
      specs: [{
        id: 'gallery-fixture-home',
        title: '[HOME-001] home layout is visually reviewable',
        file: 'tests/smoke.spec.ts',
        line: 1,
        column: 1,
        tests: [{
          expectedStatus: 'passed',
          projectId: 'single-site-mobile-chromium',
          projectName: 'single-site-mobile-chromium',
          annotations: [
            { type: 'audit-case-id', description: 'HOME-001::single-site' },
            { type: 'audit-evidence-policy', description: JSON.stringify({ mode: 'static-screenshot', rationale: 'Static layout review.' }) },
          ],
          results: [{
            status: 'passed',
            duration: 25,
            retry: 0,
            startTime: '2026-08-25T12:00:00.000Z',
            errors: [],
            stdout: [],
            stderr: [],
            attachments: [{ name: 'home-layout', contentType: 'image/png', path: screenshot }],
          }],
        }],
      }],
      suites: [],
    }],
    errors: [],
    stats: { startTime: '2026-08-25T12:00:00.000Z', duration: 25, expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
  };
  await fs.writeFile(path.join(artifactRoot, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  const before = await fs.readFile(path.join(artifactRoot, 'results.json'));
  const shared = sharedPublicationFixture('single-site', 'single-site-gallery-publication');
  const publication = await publishSingleSiteGallery({
    artifactRoot,
    outputDir,
    generatedAt: '2026-08-25T12:00:00.000Z',
    sharedPublication: {
      envelope: shared.envelope,
      binding: {
        runId: shared.view.publication.runId,
        mode: 'single-site',
        finalSubjectDigest: shared.view.subjectDigest as `sha256:${string}`,
        runRevision: shared.view.revisions.run,
        publicationDigest: shared.view.publication.envelopeDigest as `sha256:${string}`,
      },
    },
  });
  assert.equal(publication.kind, 'single-site-gallery-publication');
  assert.equal((publication.descriptor as { primaryCounts: { images: number } }).primaryCounts.images, 1);
  assert.deepEqual(await fs.readFile(path.join(artifactRoot, 'results.json')), before, 'Gallery publication must not mutate processed evidence.');
  const current = JSON.parse(await fs.readFile(path.join(outputDir, 'gallery', 'current.json'), 'utf8')) as { primaryCounts: { images: number } };
  assert.equal(current.primaryCounts.images, 1);
  assert.equal((await fs.lstat(path.join(outputDir, 'gallery.html'))).isFile(), true);
  process.stdout.write('Single-site gallery publication self-test passed: processed evidence is immutable and the sealed gallery is reviewable.\n');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
