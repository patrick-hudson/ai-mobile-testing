import type { OriginBoundFetchOptions } from './outbound-url-policy.mjs';
import type {
  RouteCandidate,
  RouteInventoryLimits,
  RouteInventoryManifest,
} from './route-inventory.mjs';

export interface LiveRouteInventoryLimits {
  maxSitemaps: number;
  maxSitemapDepth: number;
  maxSitemapBytes: number;
}

export interface LiveRouteInventoryOptions {
  origin: string;
  catalogRoutes: Array<string | RouteCandidate>;
  deploymentRoutes?: Array<string | RouteCandidate>;
  entryPoints?: Array<string | RouteCandidate>;
  outbound: Omit<OriginBoundFetchOptions, 'origin'>;
  limits?: Partial<LiveRouteInventoryLimits>;
  routeInventoryLimits?: Partial<RouteInventoryLimits>;
  now?: () => number;
}

export interface InertNavigationCandidate extends RouteCandidate {
  from: string;
  method: string;
  discoveryKind: 'link' | 'form';
}

export type LiveDiscoverySource =
  | 'robots'
  | 'sitemap'
  | 'static-navigation'
  | 'deployment-manifest';

export interface LiveRouteDiagnosticEntry {
  code: string;
  source: LiveDiscoverySource;
  url: string | null;
  detail: string;
  from?: string;
}

export interface LiveFetchEvidence {
  requestedUrl: string;
  finalUrl: string | null;
  purposes: string[];
  statusCode: number | null;
  contentType: string | null;
  bodyBytes: number;
  hops: Array<{
    url: string;
    statusCode: number;
    resolvedAddresses: string[];
    connectedAddress: string;
    location: string | null;
  }>;
  failure?: { code: string; detail: string };
}

export interface LiveRouteInventoryDiagnostic {
  schemaVersion: 1;
  kind: 'live-route-inventory-diagnostic';
  origin: string;
  capabilities: {
    scriptExecution: false;
    browserRendering: false;
    formSubmission: false;
    productOracleDerivation: false;
    findingDerivation: false;
  };
  limits: LiveRouteInventoryLimits;
  sources: {
    catalog: { supplied: true; candidateCount: number };
    deploymentManifest: { supplied: boolean; candidateCount: number };
    robots: { url: string; statusCode: number | null; bodyBytes: number; sitemapDirectives: number };
    sitemap: {
      documents: Array<{
        requestedUrl: string;
        finalUrl: string;
        from: string | null;
        depth: number;
        statusCode: number;
        contentType: string | null;
        bodyBytes: number;
        kind: 'sitemap-index' | 'url-set' | 'unknown';
      }>;
      candidateCount: number;
      totalBodyBytes: number;
    };
    navigation: { mode: 'static-root-html'; browserRendered: false; candidateCount: number };
  };
  fetchEvidence: LiveFetchEvidence[];
  failures: LiveRouteDiagnosticEntry[];
  exclusions: LiveRouteDiagnosticEntry[];
  limitations: LiveRouteDiagnosticEntry[];
  inventory: RouteInventoryManifest;
}

export const LIVE_ROUTE_INVENTORY_SCHEMA_VERSION: 1;
export const DEFAULT_LIVE_ROUTE_INVENTORY_LIMITS: Readonly<LiveRouteInventoryLimits>;
export function parseInertHtmlNavigation(html: string, documentUrl: string): InertNavigationCandidate[];
export function buildLiveRouteInventory(options: LiveRouteInventoryOptions): Promise<LiveRouteInventoryDiagnostic>;
