export const NETSKOPE_ROOT_SPKI = 'eRyc9Ah/rQ8Fu2Uaci8ye7BVx0YPztfFIC0yU91/99A=';

const DEFAULT_CANDIDATE_URL = 'https://beta.quitting7oh-org.pages.dev';
const DEFAULT_PRODUCTION_URL = 'https://quitting7oh.org';
const PROTECTED_PRODUCTION_HOSTS = new Set(['quitting7oh.org', 'www.quitting7oh.org']);

export function chromiumNetskopeTrustArgument(): string {
  return `--ignore-certificate-errors-spki-list=${NETSKOPE_ROOT_SPKI}`;
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.+$/, '');
}

export function candidateCertificateBypassAllowed(
  candidateUrl = process.env.CANDIDATE_URL ?? DEFAULT_CANDIDATE_URL,
  productionUrl = process.env.PRODUCTION_URL ?? DEFAULT_PRODUCTION_URL,
): boolean {
  const candidate = new URL(candidateUrl);
  const production = new URL(productionUrl);
  const candidateHostname = normalizedHostname(candidate);
  const productionHostname = normalizedHostname(production);
  return candidate.origin !== production.origin
    && candidateHostname !== productionHostname
    && !PROTECTED_PRODUCTION_HOSTS.has(candidateHostname);
}

export function assertCandidateCertificateBypassAllowed(
  candidateUrl = process.env.CANDIDATE_URL ?? DEFAULT_CANDIDATE_URL,
  productionUrl = process.env.PRODUCTION_URL ?? DEFAULT_PRODUCTION_URL,
): true {
  if (!candidateCertificateBypassAllowed(candidateUrl, productionUrl)) {
    throw new Error(
      'CANDIDATE_IGNORE_HTTPS_ERRORS=1 is forbidden when the candidate uses the production origin, production hostname, or a protected Quitting7OH production hostname.',
    );
  }
  return true;
}

export function candidateCertificateBypassApplies(targetUrl: string): boolean {
  if (process.env.CANDIDATE_IGNORE_HTTPS_ERRORS !== '1') return false;
  const target = new URL(targetUrl);
  const candidateUrl = process.env.CANDIDATE_URL ?? DEFAULT_CANDIDATE_URL;
  const productionUrl = process.env.PRODUCTION_URL ?? DEFAULT_PRODUCTION_URL;
  const candidate = new URL(candidateUrl);
  return target.origin === candidate.origin
    && candidateCertificateBypassAllowed(candidateUrl, productionUrl);
}
