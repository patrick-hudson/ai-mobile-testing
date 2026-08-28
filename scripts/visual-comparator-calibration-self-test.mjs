import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { VISUAL_COMPARISON_POLICY } from '../audit/visual-policy.js';
import { visualBaselineDigest } from '../shared/visual-baseline-contract.mjs';
import {
  VISUAL_COMPARATOR_CALIBRATION_CORPUS_DIGEST,
  VISUAL_COMPARATOR_CALIBRATION_REVISION,
  verifyVisualComparatorCalibration,
} from './lib/visual-comparator-calibration.mjs';

const verified = await verifyVisualComparatorCalibration();
assert.equal(verified.corpusRevision, VISUAL_COMPARATOR_CALIBRATION_REVISION);
assert.equal(verified.corpusDigest, VISUAL_COMPARATOR_CALIBRATION_CORPUS_DIGEST);
assert.equal(verified.defectCases, 6);
assert.equal(verified.acceptedNoiseCases, 2);
assert.match(verified.corpusDigest, /^sha256:[a-f0-9]{64}$/);
assert.match(verified.verificationDigest, /^sha256:[a-f0-9]{64}$/);
assert.deepEqual(verified.dependencies, { pixelmatch: '7.1.0', pngjs: '7.0.0' });

const source = fileURLToPath(new URL('../fixtures/visual-comparator-calibration/v1/', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-comparator-calibration-tamper-'));
const regenerated = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-comparator-calibration-regenerated-'));
try {
  await fs.cp(source, temporary, { recursive: true });
  const manifestPath = path.join(temporary, 'corpus.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const defect = manifest.cases.find(({ classification }) => classification === 'defect');
  const file = path.join(temporary, defect.file);
  const bytes = await fs.readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(file, bytes);
  await assert.rejects(
    verifyVisualComparatorCalibration({ corpusDirectory: temporary }),
    /bytes do not match the manifest/,
  );

  await fs.cp(source, regenerated, { recursive: true });
  const regeneratedManifestPath = path.join(regenerated, 'corpus.json');
  const regeneratedManifest = JSON.parse(await fs.readFile(regeneratedManifestPath, 'utf8'));
  const baselinePath = path.join(regenerated, regeneratedManifest.baseline.file);
  const baselineImage = PNG.sync.read(await fs.readFile(baselinePath));
  baselineImage.data.set([16, 185, 129, 255], 0);
  const baselineBytes = PNG.sync.write(baselineImage);
  await fs.writeFile(baselinePath, baselineBytes);
  regeneratedManifest.baseline.bytes = baselineBytes.length;
  regeneratedManifest.baseline.sha256 = visualBaselineDigest(baselineBytes);
  for (const [index, item] of regeneratedManifest.cases.entries()) {
    const casePath = path.join(regenerated, item.file);
    const currentImage = PNG.sync.read(await fs.readFile(casePath));
    if (index === 0) currentImage.data.set([249, 115, 22, 255], 4);
    const currentBytes = PNG.sync.write(currentImage);
    await fs.writeFile(casePath, currentBytes);
    const diff = new Uint8Array(baselineImage.width * baselineImage.height * 4);
    item.expectedDifferingPixels = pixelmatch(
      baselineImage.data,
      currentImage.data,
      diff,
      baselineImage.width,
      baselineImage.height,
      {
        includeAA: VISUAL_COMPARISON_POLICY.includeAA,
        threshold: VISUAL_COMPARISON_POLICY.threshold,
        alpha: VISUAL_COMPARISON_POLICY.alpha,
        diffColor: VISUAL_COMPARISON_POLICY.diffColor,
        aaColor: VISUAL_COMPARISON_POLICY.aaColor,
      },
    );
    item.expectedStatus = item.expectedDifferingPixels / (baselineImage.width * baselineImage.height)
      <= VISUAL_COMPARISON_POLICY.maximumDifferingPixelRatio ? 'UNCHANGED' : 'CHANGED';
    item.bytes = currentBytes.length;
    item.sha256 = visualBaselineDigest(currentBytes);
  }
  const { corpusDigest: _oldCorpusDigest, ...regeneratedBody } = regeneratedManifest;
  regeneratedManifest.corpusDigest = visualBaselineDigest(regeneratedBody);
  assert.notEqual(regeneratedManifest.corpusDigest, VISUAL_COMPARATOR_CALIBRATION_CORPUS_DIGEST);
  await fs.writeFile(regeneratedManifestPath, `${JSON.stringify(regeneratedManifest)}\n`);
  await assert.rejects(
    verifyVisualComparatorCalibration({ corpusDirectory: regenerated }),
    /independently pinned reviewed digest/,
    'a fully regenerated and internally recomputed corpus cannot reuse the reviewed v1 revision',
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(regenerated, { recursive: true, force: true });
}

process.stdout.write('visual comparator calibration self-test passed\n');
