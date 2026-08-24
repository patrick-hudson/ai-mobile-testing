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

const productionUnavailable = new Set([
  '/start-here/7-oh-withdrawal-quickstart',
  '/start-here/7-oh-withdrawal-guide',
  '/about/site-architecture',
]);

export function resolveEnvironmentPath(environment: AuditEnvironment, candidatePath: string): string | null {
  if (environment === 'candidate') return candidatePath;
  if (productionUnavailable.has(candidatePath)) return null;
  if (candidatePath === '/medications-supplements') return '/other-tools';
  if (candidatePath.startsWith('/medications-supplements/')) {
    return candidatePath.replace('/medications-supplements/', '/other-tools/');
  }
  if (candidatePath === '/about/acknowledgments') return '/about/for-fly';
  return candidatePath;
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
