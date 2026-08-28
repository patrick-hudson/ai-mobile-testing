import { assertProjectEvidenceAuthority } from './evidence-policy.js';
import type {
  AuditEnvironment,
  AuditProjectMetadata,
  ComparativeAuditProjectMetadata,
} from './types.js';

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
  '/search',
  '/about/acknowledgments',
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

function normalizedProjectOrigin(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty origin.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) origin.`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTP(S) origin without credentials, path, query, or fragment.`);
  }
  return parsed.origin;
}

function commonProjectMetadata(value: Record<string, unknown>) {
  if (typeof value.browserLabel !== 'string' || !value.browserLabel.trim()) {
    throw new Error('Playwright project metadata browserLabel must be non-empty.');
  }
  if (value.deviceClass !== 'mobile' && value.deviceClass !== 'tablet' && value.deviceClass !== 'desktop') {
    throw new Error('Playwright project metadata deviceClass is invalid.');
  }
  if (typeof value.fullSweep !== 'boolean' || typeof value.visual !== 'boolean') {
    throw new Error('Playwright project metadata fullSweep and visual must be boolean.');
  }
  return {
    browserLabel: value.browserLabel,
    deviceClass: value.deviceClass,
    fullSweep: value.fullSweep,
    visual: value.visual,
    baseURL: normalizedProjectOrigin(value.baseURL, 'Playwright project metadata baseURL'),
  } as const;
}

export function parseAuditProjectMetadata(value: unknown): AuditProjectMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Playwright project metadata must be an object.');
  }
  const metadata = value as Record<string, unknown>;
  const common = commonProjectMetadata(metadata);
  let parsed: AuditProjectMetadata;
  if (metadata.mode === 'comparative') {
    if ((metadata.environment !== 'production' && metadata.environment !== 'candidate')
      || (metadata.tlsPolicy !== 'strict' && metadata.tlsPolicy !== 'ignored-for-development')
      || metadata.deploymentRole !== undefined || metadata.sourceComparativeTargetId !== undefined) {
      throw new Error('Comparative Playwright project metadata has invalid or mixed mode fields.');
    }
    parsed = {
      ...common,
      mode: 'comparative',
      environment: metadata.environment,
      tlsPolicy: metadata.tlsPolicy,
      evidenceAuthority: metadata.evidenceAuthority as AuditProjectMetadata['evidenceAuthority'],
    };
  } else if (metadata.mode === 'single-site') {
    if ((metadata.deploymentRole !== 'preview' && metadata.deploymentRole !== 'production')
      || (metadata.tlsPolicy !== 'strict' && metadata.tlsPolicy !== 'preview-bypass')
      || typeof metadata.sourceComparativeTargetId !== 'string' || !metadata.sourceComparativeTargetId.trim()
      || metadata.environment !== undefined) {
      throw new Error('Single-site Playwright project metadata has invalid or mixed mode fields.');
    }
    parsed = {
      ...common,
      mode: 'single-site',
      deploymentRole: metadata.deploymentRole,
      sourceComparativeTargetId: metadata.sourceComparativeTargetId,
      tlsPolicy: metadata.tlsPolicy,
      evidenceAuthority: metadata.evidenceAuthority as AuditProjectMetadata['evidenceAuthority'],
    };
  } else {
    throw new Error('Playwright project metadata mode must be comparative or single-site.');
  }
  parsed.evidenceAuthority = assertProjectEvidenceAuthority(parsed);
  return parsed;
}

/** Comparative-only compatibility reader for existing tests and stored fixtures. */
export function projectMetadata(value: unknown): ComparativeAuditProjectMetadata {
  const metadata = value as Partial<ComparativeAuditProjectMetadata> | undefined;
  if ((value as { mode?: unknown } | undefined)?.mode === 'single-site') {
    throw new Error('Comparative projectMetadata() cannot read explicit Single-site metadata.');
  }
  if (metadata?.environment !== 'production' && metadata?.environment !== 'candidate') {
    throw new Error('Playwright project is missing valid audit environment metadata.');
  }
  const normalized: ComparativeAuditProjectMetadata = {
    mode: 'comparative',
    environment: metadata.environment,
    browserLabel: metadata.browserLabel ?? 'unknown',
    deviceClass: metadata.deviceClass ?? 'desktop',
    fullSweep: metadata.fullSweep ?? false,
    visual: metadata.visual ?? false,
    baseURL: normalizedProjectOrigin(metadata.baseURL ?? ENVIRONMENTS[metadata.environment].baseURL, 'Playwright project metadata baseURL'),
    tlsPolicy: metadata.tlsPolicy === 'ignored-for-development' ? 'ignored-for-development' : 'strict',
    evidenceAuthority: metadata.evidenceAuthority ?? (metadata.tlsPolicy === 'ignored-for-development'
      ? { status: 'non-authoritative', reasons: ['development-certificate-bypass'] }
      : { status: 'authoritative', reasons: [] }),
  };
  normalized.evidenceAuthority = assertProjectEvidenceAuthority(normalized);
  return normalized;
}

export function projectBaseURL(metadata: AuditProjectMetadata): string {
  return metadata.baseURL;
}

export function resolveProjectPath(metadata: AuditProjectMetadata, reviewedPath: string): string | null {
  return metadata.mode === 'comparative'
    ? resolveEnvironmentPath(metadata.environment, reviewedPath)
    : normalizeRoutePath(reviewedPath);
}
