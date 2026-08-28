export interface OutboundFetchLimits {
  timeoutMs: number;
  maxBodyBytes: number;
  maxRedirects: number;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface OutboundHopEvidence {
  url: string;
  statusCode: number;
  resolvedAddresses: readonly string[];
  connectedAddress: string;
  location: string | null;
}

export interface OutboundResponse {
  url: string;
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  text: string;
  redirects: readonly OutboundHopEvidence[];
  hops: readonly OutboundHopEvidence[];
}

export interface OutboundTransportRequest {
  url: URL;
  address: ResolvedAddress;
  resolvedAddresses: readonly ResolvedAddress[];
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBodyBytes: number;
  tlsRequestOptions: Readonly<{ rejectUnauthorized: false }> | null;
}

export interface OutboundTransportResponse {
  statusCode: number;
  headers?: Record<string, string | string[] | undefined>;
  body?: Uint8Array | string;
  remoteAddress: string;
}

export interface OriginBoundFetchOptions extends Partial<OutboundFetchLimits> {
  origin: string;
  allowedPorts?: readonly number[];
  lookup?: (hostname: string) => Promise<readonly (ResolvedAddress | string)[]>;
  transport?: (request: OutboundTransportRequest) => Promise<OutboundTransportResponse>;
  deploymentRole?: 'preview' | 'production';
  certificatePolicy?: 'strict' | 'preview-bypass';
  previewBypassOrigins?: readonly string[];
  tlsBypassRequestOptions?: Readonly<{ rejectUnauthorized: false }>
    | ((origin: string) => Readonly<{ rejectUnauthorized: false }>);
}

export class OutboundUrlPolicyError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
}

export const DEFAULT_OUTBOUND_FETCH_LIMITS: Readonly<OutboundFetchLimits>;
export function normalizeExactHttpOrigin(
  value: string,
  options?: { label?: string; allowedPorts?: readonly number[] },
): string;
export function isPublicIpAddress(address: string): boolean;
export function createPinnedLookup(address: ResolvedAddress): (
  hostname: string,
  options: { all?: boolean },
  callback: (error: Error | null, address: string | readonly ResolvedAddress[], family?: 4 | 6) => void,
) => void;
export function resolvePublicAddresses(
  hostname: string,
  options?: { lookup?: OriginBoundFetchOptions['lookup'] },
): Promise<ResolvedAddress[]>;
export function fetchOriginBound(input: string | URL, options: OriginBoundFetchOptions): Promise<OutboundResponse>;
export function createOriginBoundFetcher(options: OriginBoundFetchOptions): (input: string | URL) => Promise<OutboundResponse>;
