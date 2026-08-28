import type { AuditEvidenceAuthority } from './types.js';
import type { AuditRunContract, SingleSiteCertificatePolicy } from '../shared/run-contract.mjs';

export const NETSKOPE_ROOT_SPKI = 'eRyc9Ah/rQ8Fu2Uaci8ye7BVx0YPztfFIC0yU91/99A=';

const DEFAULT_CANDIDATE_URL = 'https://beta.quitting7oh-org.pages.dev';
const DEFAULT_PRODUCTION_URL = 'https://quitting7oh.org';

export function chromiumNetskopeTrustArgument(): string {
  return `--ignore-certificate-errors-spki-list=${NETSKOPE_ROOT_SPKI}`;
}

export function candidateCertificateBypassAllowed(
  _candidateUrl = process.env.CANDIDATE_URL ?? DEFAULT_CANDIDATE_URL,
  _productionUrl = process.env.PRODUCTION_URL ?? DEFAULT_PRODUCTION_URL,
): boolean {
  // Playwright and Chromium expose certificate-error bypasses at the complete
  // browser-context/process boundary. They cannot constrain the exception to
  // one origin after redirects or subresource requests, so the suite must not
  // claim an exact-origin development exception that the browser cannot enforce.
  return false;
}

export function assertCandidateCertificateBypassAllowed(
  candidateUrl = process.env.CANDIDATE_URL ?? DEFAULT_CANDIDATE_URL,
  productionUrl = process.env.PRODUCTION_URL ?? DEFAULT_PRODUCTION_URL,
): true {
  void candidateUrl;
  void productionUrl;
  throw new Error(
    'CANDIDATE_IGNORE_HTTPS_ERRORS=1 is disabled because browser-level certificate bypass cannot be restricted to the exact candidate origin. Install the development/Netskope CA instead.',
  );
}

export function candidateCertificateBypassApplies(targetUrl: string): boolean {
  void targetUrl;
  return false;
}

export interface AuditTlsDecision {
  certificatePolicy: SingleSiteCertificatePolicy;
  browserIgnoreHTTPSErrors: boolean;
  bypassOrigin: string | null;
  evidenceAuthority: AuditEvidenceAuthority;
}

function normalizedPreviewHttpsOrigin(value: string, label: string): string {
  if (!value || value !== value.trim() || value.includes('*')) {
    throw new Error(`${label} must be an exact HTTPS origin without whitespace or wildcards.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid exact HTTPS origin.`);
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.port) {
    throw new Error(`${label} must be an exact HTTPS origin on the default port without credentials, path, query, or fragment.`);
  }
  return parsed.origin;
}

export function parsePreviewTlsBypassAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const entries = raw.split(',').map((entry, index) =>
    normalizedPreviewHttpsOrigin(entry.trim(), `AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST entry ${index + 1}`));
  if (new Set(entries).size !== entries.length) {
    throw new Error('AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST must not contain duplicate origins.');
  }
  return Object.freeze(entries);
}

export function resolveAuditTlsPolicy(
  contract: AuditRunContract,
  options: { previewBypassOrigins?: readonly string[] } = {},
): AuditTlsDecision {
  if (contract.mode === 'comparative') {
    return {
      certificatePolicy: 'strict',
      browserIgnoreHTTPSErrors: false,
      bypassOrigin: null,
      evidenceAuthority: { status: 'authoritative', reasons: [] },
    };
  }
  if (contract.certificatePolicy === 'strict') {
    return {
      certificatePolicy: 'strict',
      browserIgnoreHTTPSErrors: false,
      bypassOrigin: null,
      evidenceAuthority: { status: 'authoritative', reasons: [] },
    };
  }
  if (contract.deploymentRole !== 'preview') {
    throw new Error('Certificate bypass is allowed only for a confirmed Preview deployment.');
  }
  const origin = normalizedPreviewHttpsOrigin(contract.url, 'Single-site Preview URL');
  const allowlist = options.previewBypassOrigins ?? [];
  if (!allowlist.includes(origin)) {
    throw new Error(`Certificate bypass for ${origin} is not present in the exact Preview origin allowlist.`);
  }
  return {
    certificatePolicy: 'preview-bypass',
    browserIgnoreHTTPSErrors: true,
    bypassOrigin: origin,
    evidenceAuthority: { status: 'non-authoritative', reasons: ['development-certificate-bypass'] },
  };
}
