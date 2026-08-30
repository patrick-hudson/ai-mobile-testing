import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { VISUAL_COMPARISON_POLICY } from '../audit/visual-policy.mjs';
import { visualBaselineCanonicalJson, visualBaselineDigest } from '../shared/visual-baseline-contract.mjs';

const WIDTH = 160;
const HEIGHT = 96;
const OUTPUT = fileURLToPath(new URL('../fixtures/visual-comparator-calibration/v1/', import.meta.url));

const palette = Object.freeze({
  page: [241, 245, 249, 255],
  header: [15, 23, 42, 255],
  card: [255, 255, 255, 255],
  border: [148, 163, 184, 255],
  text: [30, 41, 59, 255],
  muted: [100, 116, 139, 255],
  accent: [37, 99, 235, 255],
});

function image(fill = palette.page) {
  const value = new PNG({ width: WIDTH, height: HEIGHT, colorType: 6 });
  for (let offset = 0; offset < value.data.length; offset += 4) value.data.set(fill, offset);
  return value;
}

function clone(value) {
  const output = image();
  output.data.set(value.data);
  return output;
}

function rect(value, x, y, width, height, color) {
  for (let row = Math.max(0, y); row < Math.min(HEIGHT, y + height); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(WIDTH, x + width); column += 1) {
      value.data.set(color, (row * WIDTH + column) * 4);
    }
  }
}

function frame(value, x, y, width, height, color) {
  rect(value, x, y, width, 1, color);
  rect(value, x, y + height - 1, width, 1, color);
  rect(value, x, y, 1, height, color);
  rect(value, x + width - 1, y, 1, height, color);
}

function baselineImage() {
  const value = image();
  rect(value, 0, 0, WIDTH, 16, palette.header);
  rect(value, 10, 5, 22, 6, [255, 255, 255, 255]);
  rect(value, 122, 5, 12, 2, [203, 213, 225, 255]);
  rect(value, 138, 5, 12, 2, [203, 213, 225, 255]);
  rect(value, 10, 24, 140, 62, palette.card);
  frame(value, 10, 24, 140, 62, palette.border);
  rect(value, 20, 34, 48, 6, palette.text);
  rect(value, 20, 46, 82, 3, palette.muted);
  rect(value, 20, 53, 70, 3, palette.muted);
  rect(value, 20, 64, 28, 12, palette.accent);
  rect(value, 55, 66, 42, 3, palette.text);
  rect(value, 55, 72, 34, 3, palette.muted);
  rect(value, 120, 42, 18, 18, [219, 234, 254, 255]);
  rect(value, 126, 48, 6, 6, palette.accent);
  return value;
}

function variants(baseline) {
  const typography = clone(baseline);
  rect(typography, 20, 34, 48, 6, palette.card);
  rect(typography, 20, 32, 40, 8, palette.text);

  const spacing = clone(baseline);
  rect(spacing, 20, 64, 28, 12, palette.card);
  rect(spacing, 30, 64, 28, 12, palette.accent);

  const clipping = clone(baseline);
  rect(clipping, 132, 24, 18, 62, palette.page);

  const contrast = clone(baseline);
  rect(contrast, 20, 46, 82, 3, [199, 205, 214, 255]);
  rect(contrast, 20, 53, 70, 3, [199, 205, 214, 255]);
  rect(contrast, 55, 66, 42, 3, [188, 196, 207, 255]);

  const missing = clone(baseline);
  rect(missing, 19, 63, 30, 14, palette.card);

  const theme = image([15, 23, 42, 255]);
  rect(theme, 0, 0, WIDTH, 16, [2, 6, 23, 255]);
  rect(theme, 10, 5, 22, 6, [226, 232, 240, 255]);
  rect(theme, 122, 5, 12, 2, [100, 116, 139, 255]);
  rect(theme, 138, 5, 12, 2, [100, 116, 139, 255]);
  rect(theme, 10, 24, 140, 62, [30, 41, 59, 255]);
  frame(theme, 10, 24, 140, 62, [71, 85, 105, 255]);
  rect(theme, 20, 34, 48, 6, [241, 245, 249, 255]);
  rect(theme, 20, 46, 82, 3, [148, 163, 184, 255]);
  rect(theme, 20, 53, 70, 3, [148, 163, 184, 255]);
  rect(theme, 20, 64, 28, 12, [96, 165, 250, 255]);
  rect(theme, 55, 66, 42, 3, [226, 232, 240, 255]);
  rect(theme, 55, 72, 34, 3, [148, 163, 184, 255]);
  rect(theme, 120, 42, 18, 18, [30, 64, 175, 255]);
  rect(theme, 126, 48, 6, 6, [147, 197, 253, 255]);

  const sparseNoise = clone(baseline);
  for (let index = 0; index < 16; index += 1) {
    rect(sparseNoise, 3 + index * 9, 90 + (index % 2), 1, 1, [236, 72, 153, 255]);
  }

  const subthresholdNoise = clone(baseline);
  rect(subthresholdNoise, 72, 2, 38, 10, [18, 26, 45, 255]);

  return [
    { id: 'typography-defect', category: 'typography', classification: 'defect', expectedStatus: 'CHANGED', image: typography },
    { id: 'spacing-defect', category: 'spacing', classification: 'defect', expectedStatus: 'CHANGED', image: spacing },
    { id: 'clipping-defect', category: 'clipping', classification: 'defect', expectedStatus: 'CHANGED', image: clipping },
    { id: 'contrast-defect', category: 'contrast', classification: 'defect', expectedStatus: 'CHANGED', image: contrast },
    { id: 'missing-element-defect', category: 'missing-element', classification: 'defect', expectedStatus: 'CHANGED', image: missing },
    { id: 'theme-defect', category: 'theme', classification: 'defect', expectedStatus: 'CHANGED', image: theme },
    { id: 'sparse-rendering-noise', category: 'rendering-noise', classification: 'accepted-noise', expectedStatus: 'UNCHANGED', image: sparseNoise },
    { id: 'subthreshold-color-noise', category: 'rendering-noise', classification: 'accepted-noise', expectedStatus: 'UNCHANGED', image: subthresholdNoise },
  ];
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function comparison(baseline, current) {
  const output = Buffer.alloc(WIDTH * HEIGHT * 4);
  const differingPixels = pixelmatch(baseline.data, current.data, output, WIDTH, HEIGHT, {
    includeAA: VISUAL_COMPARISON_POLICY.includeAA,
    threshold: VISUAL_COMPARISON_POLICY.threshold,
    alpha: VISUAL_COMPARISON_POLICY.alpha,
    diffColor: VISUAL_COMPARISON_POLICY.diffColor,
    aaColor: VISUAL_COMPARISON_POLICY.aaColor,
  });
  return { differingPixels, differingPixelRatio: differingPixels / (WIDTH * HEIGHT) };
}

await fs.mkdir(OUTPUT, { recursive: true });
const baseline = baselineImage();
const baselineBytes = PNG.sync.write(baseline);
await fs.writeFile(path.join(OUTPUT, 'baseline.png'), baselineBytes);
const cases = [];
for (const item of variants(baseline)) {
  const bytes = PNG.sync.write(item.image);
  const filename = `${item.id}.png`;
  await fs.writeFile(path.join(OUTPUT, filename), bytes);
  cases.push({
    id: item.id,
    category: item.category,
    classification: item.classification,
    expectedStatus: item.expectedStatus,
    expectedDifferingPixels: comparison(baseline, item.image).differingPixels,
    file: filename,
    bytes: bytes.length,
    sha256: digest(bytes),
  });
}
const body = {
  schemaVersion: 1,
  kind: 'visual-comparator-calibration-corpus',
  revision: 'visual-comparator-real-png-v1',
  policyRevision: VISUAL_COMPARISON_POLICY.revision,
  dimensions: { width: WIDTH, height: HEIGHT },
  baseline: { file: 'baseline.png', bytes: baselineBytes.length, sha256: digest(baselineBytes) },
  cases,
};
const manifest = { ...body, corpusDigest: visualBaselineDigest(body) };
await fs.writeFile(path.join(OUTPUT, 'corpus.json'), `${visualBaselineCanonicalJson(manifest)}\n`);
process.stdout.write(`Generated ${cases.length} real PNG calibration cases at ${OUTPUT}.\n`);
