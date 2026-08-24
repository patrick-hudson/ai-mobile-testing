import type { AuditEnvironment, AuditProjectMetadata } from './types.js';

export const ENVIRONMENTS: Record<AuditEnvironment, { label: string; baseURL: string }> = {
  production: {
    label: 'Production baseline',
    baseURL: process.env.PRODUCTION_URL ?? 'https://quitting7oh.org',
  },
  candidate: {
    label: 'Beta release candidate',
    baseURL: process.env.CANDIDATE_URL ?? 'https://beta.quitting7oh-org.pages.dev',
  },
};

export const APPROVED_CANDIDATE_ADDITION_PATHS = [
  '/start-here/7-oh-withdrawal-quickstart',
  '/start-here/7-oh-withdrawal-guide',
  '/about/site-architecture',
] as const;

const productionUnavailable = new Set<string>(APPROVED_CANDIDATE_ADDITION_PATHS);

/**
 * Reviewed legacy aliases. These are deliberately explicit: adding a new
 * redirect or renaming a destination must change this ledger, rather than
 * being silently accepted by a crawl.
 */
export const LEGACY_ROUTE_REDIRECTS = [
  { sourcePath: '/other-tools', candidatePath: '/medications-supplements', expectedLocationPath: '/medications-supplements/' },
  { sourcePath: '/other-tools/helper-meds-info', candidatePath: '/medications-supplements/helper-meds', expectedLocationPath: '/medications-supplements/helper-meds/' },
  { sourcePath: '/start-here/withdrawal-help', candidatePath: '/start-here/7-oh-withdrawal-help', expectedLocationPath: '/start-here/7-oh-withdrawal-help/' },
  { sourcePath: '/post-acute/what-is-paws', candidatePath: '/post-acute/paws-post-acute-withdrawal', expectedLocationPath: '/post-acute/paws-post-acute-withdrawal/' },
  { sourcePath: '/mat-suboxone/suboxone-cows', candidatePath: '/mat-suboxone/sows-cows-induction-guide', expectedLocationPath: '/mat-suboxone/sows-cows-induction-guide/' },
  { sourcePath: '/about/for-fly', candidatePath: '/about/acknowledgments', expectedLocationPath: '/about/acknowledgments/' },
  { sourcePath: '/about/how-ai-was-used', candidatePath: '/about/this-site', expectedLocationPath: '/about/this-site/#ai-assisted-writing' },
] as const;

/** Production pages intentionally removed in the redesign. Empty means fail closed. */
export const APPROVED_PRODUCTION_REMOVALS: Readonly<Record<string, string>> = Object.freeze({});

const candidateToProductionOverrides = new Map<string, string>([
  ['/medications-supplements', '/other-tools'],
  ['/medications-supplements/helper-meds', '/other-tools/helper-meds-info'],
  ['/about/acknowledgments', '/about/for-fly'],
]);

function normalizeRoutePath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

export function resolveEnvironmentPath(environment: AuditEnvironment, candidatePath: string): string | null {
  if (environment === 'candidate') return candidatePath;
  if (productionUnavailable.has(candidatePath)) return null;
  const override = candidateToProductionOverrides.get(candidatePath);
  if (override) return override;
  if (candidatePath === '/medications-supplements') return '/other-tools';
  if (candidatePath.startsWith('/medications-supplements/')) {
    return candidatePath.replace('/medications-supplements/', '/other-tools/');
  }
  return candidatePath;
}

export type ProductionRouteDisposition =
  | { disposition: 'mapped'; productionPath: string; candidatePath: string }
  | { disposition: 'approved-removal'; productionPath: string; reason: string }
  | { disposition: 'unreviewed'; productionPath: string };

/**
 * Resolve a production-first inventory entry. The caller still verifies that
 * the returned candidate path is present in the reviewed candidate inventory;
 * this function only applies explicit rename rules.
 */
export function productionRouteDisposition(productionPath: string): ProductionRouteDisposition {
  const normalized = normalizeRoutePath(productionPath);
  const removalReason = APPROVED_PRODUCTION_REMOVALS[normalized];
  if (removalReason) return { disposition: 'approved-removal', productionPath: normalized, reason: removalReason };

  const explicit = LEGACY_ROUTE_REDIRECTS.find(({ sourcePath }) => sourcePath === normalized);
  if (explicit) {
    return { disposition: 'mapped', productionPath: normalized, candidatePath: explicit.candidatePath };
  }
  if (normalized === '/other-tools') {
    return { disposition: 'mapped', productionPath: normalized, candidatePath: '/medications-supplements' };
  }
  if (normalized.startsWith('/other-tools/')) {
    return {
      disposition: 'mapped',
      productionPath: normalized,
      candidatePath: normalized.replace('/other-tools/', '/medications-supplements/'),
    };
  }
  return { disposition: 'mapped', productionPath: normalized, candidatePath: normalized };
}

export function projectMetadata(value: unknown): AuditProjectMetadata {
  const metadata = value as Partial<AuditProjectMetadata> | undefined;
  if (metadata?.environment !== 'production' && metadata?.environment !== 'candidate') {
    throw new Error('Playwright project is missing valid audit environment metadata.');
  }
  return {
    environment: metadata.environment,
    browserLabel: metadata.browserLabel ?? 'unknown',
    deviceClass: metadata.deviceClass ?? 'desktop',
    fullSweep: metadata.fullSweep ?? false,
    visual: metadata.visual ?? false,
    tlsPolicy: metadata.tlsPolicy === 'ignored-for-development' ? 'ignored-for-development' : 'strict',
  };
}
