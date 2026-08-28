import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VISUAL_COMPARISON_POLICY,
  classifyVisualDifference,
  visualComparisonUnavailable,
  type VisualComparisonResult,
} from '../audit/visual-policy.js';

const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const INSTALL_MESSAGE = 'Visual comparison requires direct dependencies pixelmatch@7.1.0 and pngjs@7.0.0; add them to package.json and the lockfile before enabling production comparisons.';

export interface DecodedVisualImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface VisualComparisonDependencies {
  decodePng(bytes: Uint8Array): DecodedVisualImage;
  encodePng(image: DecodedVisualImage): Uint8Array;
  pixelmatch(
    baseline: Uint8Array,
    current: Uint8Array,
    output: Uint8Array,
    width: number,
    height: number,
    options: {
      includeAA: boolean;
      threshold: number;
      alpha: number;
      diffColor: readonly [number, number, number];
      aaColor: readonly [number, number, number];
    },
  ): number;
}

export interface VisualImageComparison {
  comparison: VisualComparisonResult;
  width: number;
  height: number;
  baselineDimensions: { width: number; height: number };
  currentDimensions: { width: number; height: number };
  dimensionChanged: boolean;
  diffPng: Uint8Array;
}

export class VisualComparisonDependencyError extends Error {
  constructor(message = INSTALL_MESSAGE) {
    super(message);
    this.name = 'VisualComparisonDependencyError';
  }
}

function dimensions(image: DecodedVisualImage, label: string): DecodedVisualImage {
  if (!Number.isSafeInteger(image.width) || image.width < 1 || image.width > 20_000
    || !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 20_000
    || !(image.data instanceof Uint8Array) || image.data.length !== image.width * image.height * 4) {
    throw new TypeError(`${label} is not a bounded decoded RGBA image.`);
  }
  return image;
}

function canvas(image: DecodedVisualImage, width: number, height: number): Uint8Array {
  if (image.width === width && image.height === height) return image.data;
  const output = new Uint8Array(width * height * 4);
  for (let row = 0; row < image.height; row += 1) {
    const sourceStart = row * image.width * 4;
    output.set(image.data.subarray(sourceStart, sourceStart + image.width * 4), row * width * 4);
  }
  return output;
}

export async function loadVisualComparisonDependencies(): Promise<VisualComparisonDependencies> {
  try {
    // Variable specifiers keep these required production dependencies out of the
    // TypeScript resolver until the package manifest deliberately declares them.
    const pixelmatchName = 'pixelmatch';
    const pngjsName = 'pngjs';
    const [pixelmatchModule, pngModule] = await Promise.all([import(pixelmatchName), import(pngjsName)]);
    const pixelmatch = pixelmatchModule.default as VisualComparisonDependencies['pixelmatch'];
    const PNG = (pngModule as unknown as { PNG: {
      sync: {
        read(bytes: Uint8Array): { width: number; height: number; data: Uint8Array };
        write(image: { width: number; height: number; data: Uint8Array }): Uint8Array;
      };
    } }).PNG;
    if (typeof pixelmatch !== 'function' || !PNG?.sync?.read || !PNG?.sync?.write) throw new Error('unsupported module interface');
    return {
      decodePng: (bytes) => PNG.sync.read(bytes),
      encodePng: (image) => PNG.sync.write(image),
      pixelmatch,
    };
  } catch (error) {
    throw new VisualComparisonDependencyError(`${INSTALL_MESSAGE} (${error instanceof Error ? error.message : 'module load failed'})`);
  }
}

export function compareVisualImageBuffers(
  baselineBytes: Uint8Array,
  currentBytes: Uint8Array,
  dependencies: VisualComparisonDependencies,
): VisualImageComparison {
  if (!(baselineBytes instanceof Uint8Array) || baselineBytes.length < 1 || baselineBytes.length > MAX_IMAGE_BYTES
    || !(currentBytes instanceof Uint8Array) || currentBytes.length < 1 || currentBytes.length > MAX_IMAGE_BYTES) {
    throw new TypeError('Visual comparison inputs must be bounded non-empty PNG byte buffers.');
  }
  const baseline = dimensions(dependencies.decodePng(baselineBytes), 'Baseline PNG');
  const current = dimensions(dependencies.decodePng(currentBytes), 'Current PNG');
  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);
  const baselineCanvas = canvas(baseline, width, height);
  const currentCanvas = canvas(current, width, height);
  const diff = new Uint8Array(width * height * 4);
  const differingPixels = dependencies.pixelmatch(
    baselineCanvas,
    currentCanvas,
    diff,
    width,
    height,
    {
      includeAA: VISUAL_COMPARISON_POLICY.includeAA,
      threshold: VISUAL_COMPARISON_POLICY.threshold,
      alpha: VISUAL_COMPARISON_POLICY.alpha,
      diffColor: VISUAL_COMPARISON_POLICY.diffColor,
      aaColor: VISUAL_COMPARISON_POLICY.aaColor,
    },
  );
  return Object.freeze({
    comparison: classifyVisualDifference({ differingPixels, totalPixels: width * height }),
    width,
    height,
    baselineDimensions: { width: baseline.width, height: baseline.height },
    currentDimensions: { width: current.width, height: current.height },
    dimensionChanged: baseline.width !== current.width || baseline.height !== current.height,
    diffPng: dependencies.encodePng({ width, height, data: diff }),
  });
}

async function boundedRegularFile(pathValue: string, label: string): Promise<Uint8Array> {
  const path = resolve(pathValue);
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) {
    throw new TypeError(`${label} must be a bounded regular non-symlink file.`);
  }
  const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { return await handle.readFile(); } finally { await handle.close(); }
}

export async function compareVisualBaselineFiles(input: {
  baselinePath: string;
  currentPath: string;
  dependencies?: VisualComparisonDependencies;
}): Promise<VisualImageComparison | { comparison: VisualComparisonResult; error: string }> {
  let dependencies;
  try { dependencies = input.dependencies ?? await loadVisualComparisonDependencies(); } catch (error) {
    return {
      comparison: visualComparisonUnavailable('unavailable', 'The pinned visual comparison dependencies are unavailable.'),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return compareVisualImageBuffers(
      await boundedRegularFile(input.baselinePath, 'Baseline PNG'),
      await boundedRegularFile(input.currentPath, 'Current PNG'),
      dependencies,
    );
  } catch (error) {
    return {
      comparison: visualComparisonUnavailable('unavailable', 'Visual comparison could not decode or compare the supplied PNG evidence.'),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string | null => {
    const index = args.indexOf(name);
    const candidate = index >= 0 ? args[index + 1] : undefined;
    return candidate ?? null;
  };
  const baselinePath = value('--baseline');
  const currentPath = value('--current');
  const diffPath = value('--diff');
  if (!baselinePath || !currentPath || !diffPath) {
    throw new Error('Usage: compare-visual-baselines.ts --baseline BASELINE.png --current CURRENT.png --diff DIFF.png');
  }
  const result = await compareVisualBaselineFiles({ baselinePath, currentPath });
  if ('diffPng' in result) {
    await fs.mkdir(dirname(resolve(diffPath)), { recursive: true });
    await fs.writeFile(resolve(diffPath), result.diffPng, { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify('diffPng' in result ? { ...result, diffPng: undefined } : result, null, 2)}\n`);
  if (!('diffPng' in result)) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
