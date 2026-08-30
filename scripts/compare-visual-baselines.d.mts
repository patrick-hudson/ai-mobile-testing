import type { VisualComparisonResult } from '../audit/visual-policy.mjs';

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
  constructor(message?: string);
}

export function loadVisualComparisonDependencies(): Promise<VisualComparisonDependencies>;

export function compareVisualImageBuffers(
  baselineBytes: Uint8Array,
  currentBytes: Uint8Array,
  dependencies: VisualComparisonDependencies,
): VisualImageComparison;

export function compareVisualBaselineFiles(input: {
  baselinePath: string;
  currentPath: string;
  dependencies?: VisualComparisonDependencies;
}): Promise<VisualImageComparison | { comparison: VisualComparisonResult; error: string }>;
