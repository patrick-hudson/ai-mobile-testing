export type RouteInventorySource = 'catalog' | 'deployment-manifest' | 'sitemap' | 'rendered-navigation' | 'crawl';

export type RouteInventoryExclusionCode =
  | 'invalid-url'
  | 'non-http'
  | 'credentialed-url'
  | 'loopback-address'
  | 'private-address'
  | 'link-local-address'
  | 'metadata-address'
  | 'cross-origin'
  | 'form-submit'
  | 'api-path'
  | 'logout-path'
  | 'download'
  | 'asset'
  | 'query-parameter-limit'
  | 'query-variant-limit'
  | 'route-limit'
  | 'depth-limit'
  | 'non-html-response'
  | 'html-byte-limit'
  | 'url-policy-rejected';

export type RouteInventoryFailureCode =
  | 'adapter-error'
  | 'fetch-error'
  | 'fetch-timeout'
  | 'invalid-response'
  | 'http-status'
  | 'url-policy-error';

export type RouteInventoryLimitationCode =
  | 'source-unavailable'
  | 'source-partial'
  | 'route-type-unenumerable'
  | 'crawl-unavailable';

export type RouteInventoryBoundCode =
  | 'route-count'
  | 'crawl-depth'
  | 'concurrency'
  | 'html-bytes'
  | 'duration'
  | 'query-variants';

export interface RouteInventoryLimits {
  maxRoutes: number;
  maxDepth: number;
  maxConcurrency: number;
  maxHtmlBytes: number;
  maxDurationMs: number;
  maxQueryVariantsPerPath: number;
  maxQueryParameters: number;
}

export interface RouteCandidate {
  url: string;
  from?: string | null;
  method?: string;
  discoveryKind?: 'link' | 'form';
  download?: boolean;
  rel?: string;
}

export interface RouteAdapterResult {
  candidates: Array<string | RouteCandidate>;
  limitations?: Array<{
    code: Exclude<RouteInventoryLimitationCode, 'crawl-unavailable'>;
    detail: string;
  }>;
}

export type RouteInventoryAdapter =
  | Array<string | RouteCandidate>
  | RouteAdapterResult
  | ((context: { origin: string; source: RouteInventorySource }) => RouteAdapterResult | Array<string | RouteCandidate> | Promise<RouteAdapterResult | Array<string | RouteCandidate>>);

export interface RouteFetchResult {
  status: number;
  contentType?: string;
  body?: string | Uint8Array;
  bodyBytes?: number;
  links?: Array<string | RouteCandidate>;
  forms?: RouteCandidate[];
  redirectUrl?: string;
}

export interface RouteInventoryOptions {
  origin: string;
  adapters?: Partial<Record<Exclude<RouteInventorySource, 'crawl'>, RouteInventoryAdapter>>;
  entryPoints?: Array<string | RouteCandidate>;
  fetchPage?: (request: {
    url: string;
    origin: string;
    depth: number;
    signal: AbortSignal;
  }) => RouteFetchResult | Promise<RouteFetchResult>;
  urlPolicy?: (request: {
    url: string;
    origin: string;
    source: RouteInventorySource;
    depth: number;
  }) => { allowed: boolean; code?: RouteInventoryExclusionCode; detail?: string } | Promise<{ allowed: boolean; code?: RouteInventoryExclusionCode; detail?: string }>;
  limits?: Partial<RouteInventoryLimits>;
  now?: () => number;
}

export interface RouteInventoryManifest {
  schemaVersion: 1;
  origin: string;
  limits: RouteInventoryLimits;
  sources: Array<{
    source: RouteInventorySource;
    candidatesObserved: number;
    includedContributions: number;
    exclusions: number;
    failures: number;
    limitations: number;
  }>;
  routes: Array<{
    url: string;
    path: string;
    query: string;
    disposition: 'included' | 'fetch-failed' | 'unreachable' | 'non-html';
    sources: Array<{ source: RouteInventorySource; from: string | null; depth: number }>;
  }>;
  exclusions: Array<{
    code: RouteInventoryExclusionCode;
    source: RouteInventorySource;
    url: string;
    from: string | null;
    depth: number;
    detail: string;
  }>;
  failures: Array<{
    code: RouteInventoryFailureCode;
    source: RouteInventorySource;
    url: string | null;
    detail: string;
  }>;
  limitations: Array<{
    code: RouteInventoryLimitationCode;
    source: RouteInventorySource;
    detail: string;
  }>;
  responses: Array<{
    url: string;
    depth: number;
    status: number;
    contentType: string | null;
    bytes: number;
  }>;
  redirects: Array<{ from: string; to: string; status: number; accepted: boolean }>;
  bounds: Array<{ code: RouteInventoryBoundCode; limit: number; observed: number; exhausted: boolean }>;
  summary: {
    routes: number;
    exclusions: number;
    failures: number;
    limitations: number;
    responses: number;
    redirects: number;
    htmlBytesConsumed: number;
  };
}

export const ROUTE_INVENTORY_SCHEMA_VERSION: 1;
export const DEFAULT_ROUTE_INVENTORY_LIMITS: Readonly<RouteInventoryLimits>;
export function buildRouteInventory(options: RouteInventoryOptions): Promise<RouteInventoryManifest>;
