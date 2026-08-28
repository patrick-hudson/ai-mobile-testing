import type { HorizontalOverflowElement } from './types.js';

export interface RawHorizontalOverflowCandidate extends Omit<HorizontalOverflowElement,
  'outsideLeftPx' | 'outsideRightPx' | 'intrinsicOverflowPx' | 'reasons' | 'nearestScrollOwner'> {
  position: string;
  containedByScrollOwner: boolean;
  nearestScrollOwner: HorizontalOverflowElement['nearestScrollOwner'];
}

export interface HorizontalOverflowClassification {
  elements: HorizontalOverflowElement[];
  candidateCount: number;
  truncated: boolean;
}

const DISPLAY_PRECISION = 100;

function rounded(value: number): number {
  return Math.round(value * DISPLAY_PRECISION) / DISPLAY_PRECISION;
}

function geometryKey(candidate: RawHorizontalOverflowCandidate): string {
  return [candidate.left, candidate.right, candidate.width, candidate.clientWidth, candidate.scrollWidth]
    .map((value) => Math.round(value * 2) / 2)
    .join('|');
}

export function classifyHorizontalOverflowCandidates(
  rootOverflowPx: number,
  viewportWidth: number,
  rawCandidates: readonly RawHorizontalOverflowCandidate[],
  limit = 20,
): HorizontalOverflowClassification {
  if (rootOverflowPx <= 1) return { elements: [], candidateCount: 0, truncated: false };

  const ranked = rawCandidates
    .flatMap((candidate) => {
      if (candidate.position === 'fixed' || candidate.containedByScrollOwner) return [];
      const outsideLeftPx = Math.max(0, -candidate.left);
      const outsideRightPx = Math.max(0, candidate.right - viewportWidth);
      const intrinsicOverflowPx = Math.max(0, candidate.scrollWidth - candidate.clientWidth);
      const reasons: string[] = [];
      if (outsideLeftPx > 1) reasons.push('extends-left-of-viewport');
      if (outsideRightPx > 1) reasons.push('extends-right-of-viewport');
      if (intrinsicOverflowPx > 1 && candidate.overflowX === 'visible') reasons.push('intrinsic-visible-overflow');
      if (reasons.length === 0) return [];
      const element: HorizontalOverflowElement = {
        selector: candidate.selector,
        selectorMatchCount: candidate.selectorMatchCount,
        tagName: candidate.tagName,
        text: candidate.text,
        left: rounded(candidate.left),
        right: rounded(candidate.right),
        width: rounded(candidate.width),
        clientWidth: candidate.clientWidth,
        scrollWidth: candidate.scrollWidth,
        overflowX: candidate.overflowX,
        outsideLeftPx: rounded(outsideLeftPx),
        outsideRightPx: rounded(outsideRightPx),
        intrinsicOverflowPx: rounded(intrinsicOverflowPx),
        reasons,
        nearestScrollOwner: candidate.nearestScrollOwner,
      };
      const score = Math.max(outsideLeftPx, outsideRightPx, intrinsicOverflowPx);
      const depth = candidate.selector.split('>').length;
      return [{ element, score, depth, geometry: geometryKey(candidate) }];
    })
    .sort((left, right) => right.score - left.score || right.depth - left.depth);

  const byGeometry = new Map<string, (typeof ranked)[number]>();
  for (const candidate of ranked) {
    if (!byGeometry.has(candidate.geometry)) byGeometry.set(candidate.geometry, candidate);
  }
  const deduplicated = [...byGeometry.values()];
  if (deduplicated.length === 0) {
    return {
      elements: [{
        selector: 'html',
        selectorMatchCount: 1,
        tagName: 'html',
        text: '',
        left: 0,
        right: rounded(viewportWidth + rootOverflowPx),
        width: rounded(viewportWidth + rootOverflowPx),
        clientWidth: viewportWidth,
        scrollWidth: rounded(viewportWidth + rootOverflowPx),
        overflowX: 'unknown',
        outsideLeftPx: 0,
        outsideRightPx: rounded(rootOverflowPx),
        intrinsicOverflowPx: rounded(rootOverflowPx),
        reasons: ['unattributed-root-overflow'],
        nearestScrollOwner: null,
      }],
      candidateCount: 1,
      truncated: false,
    };
  }

  return {
    elements: deduplicated.slice(0, limit).map(({ element }) => element),
    candidateCount: deduplicated.length,
    truncated: deduplicated.length > limit,
  };
}
