import { constants as fsConstants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISUAL_COMPARISON_POLICY } from '../../audit/visual-policy.js';
import { visualBaselineCanonicalJson, visualBaselineDigest } from '../../shared/visual-baseline-contract.mjs';
import { loadVisualComparisonDependencies } from '../compare-visual-baselines.ts';

export const VISUAL_COMPARATOR_CALIBRATION_REVISION = 'visual-comparator-real-png-v1';
export const VISUAL_COMPARATOR_CALIBRATION_CORPUS_DIGEST = 'sha256:3b5e3f973a74824b92afda18c9d61beaf069ec8cde49163417ebe13a2d86c382';
const V1_VERIFICATION_DIGEST = 'sha256:4ceae61de8fca8604ff22a44be253d7bbf9010e74a89e138263c68eae55a4c0d';
const V1_CORPUS_DIRECTORY = fileURLToPath(new URL('../../fixtures/visual-comparator-calibration/v1/', import.meta.url));
const REQUIRED_DEFECT_CATEGORIES = Object.freeze([
  'clipping', 'contrast', 'missing-element', 'spacing', 'theme', 'typography',
]);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_CASES = 24;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const VERIFIED_DEPENDENCIES = Symbol('verified-visual-comparator-dependencies');
const require = createRequire(import.meta.url);

function frozenPolicy(value) {
  return Object.freeze({
    revision: value.revision,
    maximumDifferingPixelRatio: value.maximumDifferingPixelRatio,
    includeAA: value.includeAA,
    threshold: value.threshold,
    alpha: value.alpha,
    diffColor: Object.freeze([...value.diffColor]),
    aaColor: Object.freeze([...value.aaColor]),
  });
}

const SUPPORTED_CALIBRATIONS = Object.freeze({
  [VISUAL_COMPARATOR_CALIBRATION_REVISION]: Object.freeze({
    revision: VISUAL_COMPARATOR_CALIBRATION_REVISION,
    corpusDigest: VISUAL_COMPARATOR_CALIBRATION_CORPUS_DIGEST,
    verificationDigest: V1_VERIFICATION_DIGEST,
    corpusDirectory: V1_CORPUS_DIRECTORY,
    policy: frozenPolicy({
      revision: 'pixelmatch-css-ratio-0.0025-v1',
      maximumDifferingPixelRatio: 0.0025,
      includeAA: false,
      threshold: 0.1,
      alpha: 0.1,
      diffColor: [255, 0, 0],
      aaColor: [255, 255, 0],
    }),
    dependencies: Object.freeze({ pixelmatch: '7.1.0', pngjs: '7.0.0' }),
  }),
});

function fail(message) {
  throw new Error(`Visual comparator calibration failed: ${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value, keys, label) {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(`${label} has an unsupported shape.`);
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail(`${label} is invalid.`);
  return value;
}

function revision(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9.-]{2,119}$/.test(value)) fail(`${label} is invalid.`);
  return value;
}

function supportedCalibration(value) {
  const selected = SUPPORTED_CALIBRATIONS[revision(value, 'calibration revision')];
  if (!selected) fail(`calibration revision ${value} is not in the frozen supported-revision registry.`);
  return selected;
}

function currentPolicyShape() {
  return frozenPolicy(VISUAL_COMPARISON_POLICY);
}

async function realDirectory(value) {
  const requested = path.resolve(value);
  const stat = await fs.lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('the corpus root must be a real directory.');
  return { requested, real: await fs.realpath(requested) };
}

async function boundedFile(root, filename, maximumBytes, label) {
  if (typeof filename !== 'string' || !/^[a-z0-9][a-z0-9-]*\.(?:json|png)$/.test(filename)) fail(`${label} filename is invalid.`);
  const file = path.join(root.requested, filename);
  if (path.dirname(file) !== root.requested) fail(`${label} escaped the corpus root.`);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) fail(`${label} must be a bounded regular file.`);
  const real = await fs.realpath(file);
  if (real !== path.join(root.real, filename)) fail(`${label} escaped the corpus root.`);
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { return await handle.readFile(); } finally { await handle.close(); }
}

function validateManifest(value, supported) {
  const manifest = record(value, 'corpus manifest');
  exactKeys(manifest, [
    'schemaVersion', 'kind', 'revision', 'policyRevision', 'dimensions', 'baseline', 'cases', 'corpusDigest',
  ], 'corpus manifest');
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'visual-comparator-calibration-corpus'
    || manifest.revision !== supported.revision || manifest.policyRevision !== supported.policy.revision) {
    fail('the corpus revision and frozen visual policy revision are not compatible with this verifier.');
  }
  const dimensions = record(manifest.dimensions, 'corpus dimensions');
  exactKeys(dimensions, ['width', 'height'], 'corpus dimensions');
  if (!Number.isSafeInteger(dimensions.width) || dimensions.width < 16 || dimensions.width > 2_000
    || !Number.isSafeInteger(dimensions.height) || dimensions.height < 16 || dimensions.height > 2_000) {
    fail('corpus dimensions are invalid.');
  }
  const baseline = record(manifest.baseline, 'corpus baseline');
  exactKeys(baseline, ['file', 'bytes', 'sha256'], 'corpus baseline');
  digest(baseline.sha256, 'corpus baseline digest');
  if (!Number.isSafeInteger(baseline.bytes) || baseline.bytes < 1 || baseline.bytes > MAX_PNG_BYTES) fail('corpus baseline byte count is invalid.');
  if (!Array.isArray(manifest.cases) || manifest.cases.length < 8 || manifest.cases.length > MAX_CASES) fail('corpus case count is invalid.');
  const ids = new Set();
  const files = new Set([baseline.file]);
  const cases = manifest.cases.map((rawCase, index) => {
    const item = record(rawCase, `corpus case ${index}`);
    exactKeys(item, [
      'id', 'category', 'classification', 'expectedStatus', 'expectedDifferingPixels', 'file', 'bytes', 'sha256',
    ], `corpus case ${index}`);
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{2,79}$/.test(item.id) || ids.has(item.id)) fail(`corpus case ${index} has an invalid or duplicate ID.`);
    ids.add(item.id);
    if (typeof item.category !== 'string' || !/^[a-z][a-z0-9-]{2,39}$/.test(item.category)) fail(`corpus case ${item.id} category is invalid.`);
    if (!['defect', 'accepted-noise'].includes(item.classification)) fail(`corpus case ${item.id} classification is invalid.`);
    const requiredStatus = item.classification === 'defect' ? 'CHANGED' : 'UNCHANGED';
    if (item.expectedStatus !== requiredStatus) fail(`corpus case ${item.id} has an unsafe expected classification.`);
    if (!Number.isSafeInteger(item.expectedDifferingPixels) || item.expectedDifferingPixels < 0
      || item.expectedDifferingPixels > dimensions.width * dimensions.height) fail(`corpus case ${item.id} pixel count is invalid.`);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_PNG_BYTES) fail(`corpus case ${item.id} byte count is invalid.`);
    digest(item.sha256, `corpus case ${item.id} digest`);
    if (typeof item.file !== 'string' || files.has(item.file)) fail(`corpus case ${item.id} file is invalid or duplicated.`);
    files.add(item.file);
    return item;
  });
  const defects = cases.filter(({ classification }) => classification === 'defect');
  const defectCategories = [...new Set(defects.map(({ category }) => category))].sort();
  if (defects.length !== REQUIRED_DEFECT_CATEGORIES.length
    || defectCategories.join('\0') !== REQUIRED_DEFECT_CATEGORIES.join('\0')) fail('corpus does not cover every required defect category exactly.');
  const acceptedNoise = cases.filter(({ classification }) => classification === 'accepted-noise');
  if (acceptedNoise.length < 2 || acceptedNoise.some(({ category }) => category !== 'rendering-noise')) {
    fail('corpus needs at least two accepted rendering-noise cases.');
  }
  const { corpusDigest, ...body } = manifest;
  if (digest(corpusDigest, 'corpus digest') !== visualBaselineDigest(body)) fail('corpus manifest digest does not match its contents.');
  if (corpusDigest !== supported.corpusDigest) {
    fail(`corpus revision ${supported.revision} does not match its independently pinned reviewed digest.`);
  }
  return { manifest, dimensions, baseline, cases };
}

function assertPng(bytes, expectedBytes, expectedDigest, label) {
  if (bytes.length !== expectedBytes || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || visualBaselineDigest(bytes) !== expectedDigest) fail(`${label} bytes do not match the manifest.`);
}

function decodedImage(value, dimensions, label) {
  if (!value || value.width !== dimensions.width || value.height !== dimensions.height
    || !(value.data instanceof Uint8Array) || value.data.length !== value.width * value.height * 4) {
    fail(`${label} has unexpected decoded dimensions or pixels.`);
  }
  return value;
}

function compareCalibrationCase(baselineBytes, currentBytes, dimensions, dependencies, policy, label) {
  const baseline = decodedImage(dependencies.decodePng(baselineBytes), dimensions, 'corpus baseline');
  const current = decodedImage(dependencies.decodePng(currentBytes), dimensions, label);
  const diff = new Uint8Array(dimensions.width * dimensions.height * 4);
  const differingPixels = dependencies.pixelmatch(
    baseline.data,
    current.data,
    diff,
    dimensions.width,
    dimensions.height,
    {
      includeAA: policy.includeAA,
      threshold: policy.threshold,
      alpha: policy.alpha,
      diffColor: policy.diffColor,
      aaColor: policy.aaColor,
    },
  );
  const encoded = dependencies.encodePng({ width: dimensions.width, height: dimensions.height, data: diff });
  if (!(encoded instanceof Uint8Array) || !Buffer.from(encoded).subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail(`${label} could not encode a real PNG diff.`);
  }
  return {
    differingPixels,
    status: differingPixels / (dimensions.width * dimensions.height) <= policy.maximumDifferingPixelRatio
      ? 'UNCHANGED'
      : 'CHANGED',
  };
}

function installedVersions() {
  try {
    return {
      pixelmatch: require('pixelmatch/package.json').version,
      pngjs: require('pngjs/package.json').version,
    };
  } catch (error) {
    fail(`pinned comparator dependency metadata is unavailable (${error instanceof Error ? error.message : String(error)}).`);
  }
}

export async function verifyVisualComparatorCalibration(options = {}) {
  const selectedRevision = options.revision ?? VISUAL_COMPARATOR_CALIBRATION_REVISION;
  const supported = supportedCalibration(selectedRevision);
  const currentRevision = options.currentRevision ?? VISUAL_COMPARATOR_CALIBRATION_REVISION;
  if (selectedRevision === currentRevision && currentRevision === VISUAL_COMPARATOR_CALIBRATION_REVISION
    && visualBaselineCanonicalJson(currentPolicyShape()) !== visualBaselineCanonicalJson(supported.policy)) {
    fail('the current visual comparison policy no longer matches its frozen calibration verifier.');
  }
  const root = await realDirectory(options.corpusDirectory ?? supported.corpusDirectory);
  const manifestBytes = await boundedFile(root, 'corpus.json', MAX_MANIFEST_BYTES, 'corpus manifest');
  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('corpus manifest is invalid JSON.'); }
  const { manifest, dimensions, baseline, cases } = validateManifest(parsed, supported);
  const baselineBytes = await boundedFile(root, baseline.file, MAX_PNG_BYTES, 'corpus baseline');
  assertPng(baselineBytes, baseline.bytes, baseline.sha256, 'corpus baseline');
  const versions = installedVersions();
  if (visualBaselineCanonicalJson(versions) !== visualBaselineCanonicalJson(supported.dependencies)) {
    fail(`installed dependency versions ${JSON.stringify(versions)} do not match the frozen verifier.`);
  }
  const dependencies = await loadVisualComparisonDependencies();
  const results = [];
  for (const item of cases) {
    const currentBytes = await boundedFile(root, item.file, MAX_PNG_BYTES, `corpus case ${item.id}`);
    assertPng(currentBytes, item.bytes, item.sha256, `corpus case ${item.id}`);
    const compared = compareCalibrationCase(
      baselineBytes,
      currentBytes,
      dimensions,
      dependencies,
      supported.policy,
      `corpus case ${item.id}`,
    );
    if (compared.status !== item.expectedStatus || compared.differingPixels !== item.expectedDifferingPixels) {
      fail(`corpus case ${item.id} expected ${item.expectedStatus}/${item.expectedDifferingPixels} pixels but received ${compared.status}/${compared.differingPixels}.`);
    }
    results.push({
      id: item.id,
      category: item.category,
      classification: item.classification,
      status: compared.status,
      differingPixels: compared.differingPixels,
    });
  }
  const bindingBody = {
    schemaVersion: 1,
    kind: 'visual-comparator-calibration-binding',
    corpusRevision: manifest.revision,
    corpusDigest: manifest.corpusDigest,
    policyRevision: supported.policy.revision,
    dependencies: versions,
    defectCases: results.filter(({ classification }) => classification === 'defect').length,
    acceptedNoiseCases: results.filter(({ classification }) => classification === 'accepted-noise').length,
  };
  const binding = {
    ...bindingBody,
    verificationDigest: visualBaselineDigest({ ...bindingBody, results }),
  };
  if (binding.verificationDigest !== supported.verificationDigest) {
    fail(`calibration revision ${supported.revision} no longer produces its independently pinned verification digest.`);
  }
  Object.defineProperty(binding, VERIFIED_DEPENDENCIES, { value: dependencies, enumerable: false });
  return Object.freeze(binding);
}

export async function verifyPublishedVisualComparatorCalibration(binding, options = {}) {
  const value = record(binding, 'published calibration binding');
  const currentRevision = revision(options.currentRevision ?? VISUAL_COMPARATOR_CALIBRATION_REVISION, 'current calibration revision');
  const verified = await verifyVisualComparatorCalibration({ revision: value.corpusRevision, currentRevision });
  if (!visualComparatorCalibrationEqual(value, verified)) fail('published calibration binding does not match its frozen supported verifier.');
  // The current pointer deliberately does not select the verifier. Historical
  // publications remain readable through their own frozen revision.
  void currentRevision;
  return verified;
}

export function verifiedVisualComparisonDependencies(calibration) {
  const dependencies = calibration?.[VERIFIED_DEPENDENCIES];
  if (!dependencies) fail('comparison dependencies were not obtained from a successful calibration session.');
  return dependencies;
}

export function visualComparatorCalibrationEqual(left, right) {
  try {
    return visualBaselineCanonicalJson(left) === visualBaselineCanonicalJson(right);
  } catch {
    return false;
  }
}
