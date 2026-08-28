import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export const DEFAULT_OUTBOUND_FETCH_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  maxBodyBytes: 2 * 1024 * 1024,
  maxRedirects: 4,
});

const SAFE_REQUEST_HEADERS = Object.freeze({
  accept: '*/*',
  'accept-encoding': 'identity',
  'cache-control': 'no-cache',
  'user-agent': 'quitting7oh-audit-preflight/1',
});
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class OutboundUrlPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OutboundUrlPolicyError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function positiveInteger(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new OutboundUrlPolicyError('OUTBOUND_LIMIT_INVALID', `${label} must be a positive integer.`);
  }
  return result;
}

function nonNegativeInteger(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new OutboundUrlPolicyError('OUTBOUND_LIMIT_INVALID', `${label} must be a non-negative integer.`);
  }
  return result;
}

function normalizePort(protocol, port) {
  if (port) return Number(port);
  return protocol === 'https:' ? 443 : 80;
}

function normalizeAllowedPorts(allowedPorts) {
  const values = allowedPorts ?? [80, 443];
  if (!Array.isArray(values) || values.length === 0) {
    throw new OutboundUrlPolicyError('OUTBOUND_PORT_POLICY_INVALID', 'At least one permitted port is required.');
  }
  const ports = new Set();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new OutboundUrlPolicyError('OUTBOUND_PORT_POLICY_INVALID', `Invalid permitted port: ${String(value)}.`);
    }
    ports.add(value);
  }
  return ports;
}

function parseHttpUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new OutboundUrlPolicyError('OUTBOUND_URL_INVALID', `${label} must be a non-empty URL without surrounding whitespace.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OutboundUrlPolicyError('OUTBOUND_URL_INVALID', `${label} must be a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OutboundUrlPolicyError('OUTBOUND_SCHEME_DENIED', `${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new OutboundUrlPolicyError('OUTBOUND_CREDENTIALS_DENIED', `${label} must not contain credentials.`);
  }
  return parsed;
}

export function normalizeExactHttpOrigin(value, options = {}) {
  const parsed = parseHttpUrl(value, options.label ?? 'Origin');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new OutboundUrlPolicyError(
      'OUTBOUND_ORIGIN_INVALID',
      `${options.label ?? 'Origin'} must be an exact origin without a path, query, or fragment.`,
    );
  }
  const port = normalizePort(parsed.protocol, parsed.port);
  const protocolDefaultPort = parsed.protocol === 'https:' ? 443 : 80;
  if ((!options.allowedPorts && port !== protocolDefaultPort) || !normalizeAllowedPorts(options.allowedPorts).has(port)) {
    throw new OutboundUrlPolicyError('OUTBOUND_PORT_DENIED', `${options.label ?? 'Origin'} uses disallowed port ${port}.`);
  }
  return parsed.origin;
}

function parseIpv4(address) {
  if (isIP(address) !== 4) return null;
  return address.split('.').map(Number);
}

function parseIpv6(address) {
  const raw = address.toLowerCase().split('%', 1)[0];
  if (isIP(raw) !== 6) return null;
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const pieces = half.split(':');
    const words = [];
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const ipv4 = parseIpv4(piece);
        if (!ipv4) return null;
        words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        words.push(Number.parseInt(piece, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function ipv4Number(parts) {
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIpv4(parts) {
  const value = ipv4Number(parts);
  const denied = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  return !denied.some(([base, bits]) => ipv4InCidr(value, ipv4Number(parseIpv4(base)), bits));
}

function ipv6Prefix(words, prefix, bits) {
  const expected = parseIpv6(prefix);
  let remaining = bits;
  for (let index = 0; remaining > 0; index += 1) {
    const width = Math.min(16, remaining);
    const mask = (0xffff << (16 - width)) & 0xffff;
    if ((words[index] & mask) !== (expected[index] & mask)) return false;
    remaining -= width;
  }
  return true;
}

export function isPublicIpAddress(address) {
  if (typeof address !== 'string') return false;
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const ipv4 = parseIpv4(unwrapped);
  if (ipv4) return isPublicIpv4(ipv4);
  const ipv6 = parseIpv6(unwrapped);
  if (!ipv6) return false;

  // Treat IPv4-mapped addresses exactly like their IPv4 destination.
  if (ipv6.slice(0, 5).every((word) => word === 0) && ipv6[5] === 0xffff) {
    return isPublicIpv4([ipv6[6] >> 8, ipv6[6] & 255, ipv6[7] >> 8, ipv6[7] & 255]);
  }
  // Public IPv6 allocations are within 2000::/3. Exclude documentation and
  // benchmarking/ORCHID ranges even though they sit inside that aggregate.
  if (!ipv6Prefix(ipv6, '2000::', 3)) return false;
  if (ipv6Prefix(ipv6, '2001:2::', 48)
    || ipv6Prefix(ipv6, '2001:10::', 28)
    || ipv6Prefix(ipv6, '2001:20::', 28)
    || ipv6Prefix(ipv6, '2001:db8::', 32)) return false;
  return true;
}

function ipKey(address) {
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const ipv4 = parseIpv4(unwrapped);
  if (ipv4) return `4:${ipv4.join('.')}`;
  const ipv6 = parseIpv6(unwrapped);
  if (!ipv6) return null;
  if (ipv6.slice(0, 5).every((word) => word === 0) && ipv6[5] === 0xffff) {
    return `4:${ipv6[6] >> 8}.${ipv6[6] & 255}.${ipv6[7] >> 8}.${ipv6[7] & 255}`;
  }
  return `6:${ipv6.map((word) => word.toString(16).padStart(4, '0')).join(':')}`;
}

function hostnameWithoutBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function createPinnedLookup(address) {
  if (!address || typeof address.address !== 'string' || ![4, 6].includes(Number(address.family))) {
    throw new OutboundUrlPolicyError('OUTBOUND_PIN_INVALID', 'A valid resolved address is required for DNS pinning.');
  }
  const pinned = Object.freeze({ address: address.address, family: Number(address.family) });
  return (_hostname, options, callback) => {
    // Newer Node releases may request all addresses even for an HTTP client.
    // Returning the legacy scalar shape in that case is interpreted as an
    // address object and reaches the socket as `undefined`.
    if (options?.all === true) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
}

export async function resolvePublicAddresses(hostname, options = {}) {
  const normalizedHostname = hostnameWithoutBrackets(String(hostname).toLowerCase());
  const literalFamily = isIP(normalizedHostname);
  let answers;
  if (literalFamily) {
    answers = [{ address: normalizedHostname, family: literalFamily }];
  } else {
    const resolver = options.lookup ?? (async (name) => dnsLookup(name, { all: true, verbatim: true }));
    try {
      answers = await resolver(normalizedHostname);
    } catch (error) {
      throw new OutboundUrlPolicyError(
        'OUTBOUND_DNS_FAILED',
        `DNS resolution failed for ${normalizedHostname}.`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new OutboundUrlPolicyError('OUTBOUND_DNS_EMPTY', `DNS returned no addresses for ${normalizedHostname}.`);
  }
  const unique = new Map();
  for (const answer of answers) {
    const address = typeof answer === 'string' ? answer : answer?.address;
    const family = typeof answer === 'object' && answer !== null && answer.family ? Number(answer.family) : isIP(address);
    if (!address || (family !== 4 && family !== 6) || !isPublicIpAddress(address)) {
      throw new OutboundUrlPolicyError(
        'OUTBOUND_ADDRESS_DENIED',
        `DNS for ${normalizedHostname} returned a non-public address.`,
        { address: address ?? null },
      );
    }
    unique.set(ipKey(address), { address, family });
  }
  return [...unique.values()].sort((left, right) => `${left.family}:${left.address}`.localeCompare(`${right.family}:${right.address}`));
}

function normalizeResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    const normalizedName = name.toLowerCase();
    if (normalizedName === 'set-cookie' || normalizedName === 'set-cookie2') continue;
    result[normalizedName] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return Object.freeze(result);
}

function normalizeBody(body, maxBodyBytes) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  if (buffer.byteLength > maxBodyBytes) {
    throw new OutboundUrlPolicyError(
      'OUTBOUND_BODY_LIMIT',
      `Response exceeded the ${maxBodyBytes}-byte body limit.`,
      { receivedBytes: buffer.byteLength, maxBodyBytes },
    );
  }
  return buffer;
}

function nativeTransport(request) {
  return new Promise((resolve, reject) => {
    const client = request.url.protocol === 'https:' ? https : http;
    const selected = request.address;
    const selectedHost = hostnameWithoutBrackets(request.url.hostname);
    const options = {
      protocol: request.url.protocol,
      hostname: selectedHost,
      port: request.url.port || undefined,
      method: 'GET',
      path: `${request.url.pathname}${request.url.search}`,
      headers: request.headers,
      agent: false,
      lookup: createPinnedLookup(selected),
      ...(request.tlsRequestOptions ?? {}),
    };
    if (request.url.protocol === 'https:' && !isIP(selectedHost)) options.servername = selectedHost;

    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const clientRequest = client.request(options, (response) => {
      const remoteAddress = response.socket.remoteAddress ?? '';
      if (ipKey(remoteAddress) !== ipKey(selected.address) || !isPublicIpAddress(remoteAddress)) {
        const error = new OutboundUrlPolicyError(
          'OUTBOUND_REMOTE_ADDRESS_MISMATCH',
          `Connected address did not match the DNS-pinned public address for ${request.url.hostname}.`,
          { expectedAddress: selected.address, remoteAddress },
        );
        response.destroy(error);
        finish(reject, error);
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > request.maxBodyBytes) {
          response.destroy(new OutboundUrlPolicyError(
            'OUTBOUND_BODY_LIMIT',
            `Response exceeded the ${request.maxBodyBytes}-byte body limit.`,
            { receivedBytes: bytes, maxBodyBytes: request.maxBodyBytes },
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => finish(resolve, {
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        remoteAddress,
      }));
      response.once('error', (error) => finish(reject, error));
    });
    const timer = setTimeout(() => {
      clientRequest.destroy(new OutboundUrlPolicyError(
        'OUTBOUND_TIMEOUT',
        `Request exceeded the ${request.timeoutMs}ms timeout.`,
        { timeoutMs: request.timeoutMs },
      ));
    }, request.timeoutMs);
    timer.unref?.();
    clientRequest.once('error', (error) => finish(reject, error));
    clientRequest.end();
  });
}

function validatedTlsBypass(origin, options) {
  if (options.certificatePolicy !== undefined
    && options.certificatePolicy !== 'strict'
    && options.certificatePolicy !== 'preview-bypass') {
    throw new OutboundUrlPolicyError('OUTBOUND_TLS_POLICY_INVALID', 'certificatePolicy must be strict or preview-bypass.');
  }
  if (options.certificatePolicy !== 'preview-bypass') return null;
  if (options.deploymentRole !== 'preview') {
    throw new OutboundUrlPolicyError('OUTBOUND_TLS_BYPASS_DENIED', 'Certificate bypass is allowed only for Preview deployments.');
  }
  if (!origin.startsWith('https://')) {
    throw new OutboundUrlPolicyError('OUTBOUND_TLS_BYPASS_DENIED', 'Certificate bypass requires an HTTPS origin.');
  }
  const allowlist = (options.previewBypassOrigins ?? []).map((entry, index) =>
    normalizeExactHttpOrigin(entry, { label: `Preview bypass allowlist entry ${index + 1}`, allowedPorts: [443] }));
  if (!allowlist.includes(origin)) {
    throw new OutboundUrlPolicyError(
      'OUTBOUND_TLS_BYPASS_DENIED',
      `Certificate bypass for ${origin} is not present in the exact Preview origin allowlist.`,
    );
  }
  const injected = typeof options.tlsBypassRequestOptions === 'function'
    ? options.tlsBypassRequestOptions(origin)
    : options.tlsBypassRequestOptions;
  if (!injected || injected.rejectUnauthorized !== false || Object.keys(injected).some((key) => key !== 'rejectUnauthorized')) {
    throw new OutboundUrlPolicyError(
      'OUTBOUND_TLS_BYPASS_CONFIGURATION_INVALID',
      'Preview bypass requires an injected request option containing only rejectUnauthorized: false.',
    );
  }
  return Object.freeze({ rejectUnauthorized: false });
}

function validatedRequestUrl(value, origin, allowedPorts) {
  const parsed = value instanceof URL ? new URL(value.href) : parseHttpUrl(String(value), 'Outbound URL');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OutboundUrlPolicyError('OUTBOUND_SCHEME_DENIED', 'Outbound URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new OutboundUrlPolicyError('OUTBOUND_CREDENTIALS_DENIED', 'Outbound URL must not contain credentials.');
  }
  if (parsed.hash) {
    throw new OutboundUrlPolicyError('OUTBOUND_FRAGMENT_DENIED', 'Outbound URLs must not contain fragments.');
  }
  const port = normalizePort(parsed.protocol, parsed.port);
  if (!allowedPorts.has(port)) {
    throw new OutboundUrlPolicyError('OUTBOUND_PORT_DENIED', `Outbound URL uses disallowed port ${port}.`);
  }
  if (parsed.origin !== origin) {
    throw new OutboundUrlPolicyError(
      'OUTBOUND_ORIGIN_DENIED',
      `Outbound URL ${parsed.origin} does not match the bound origin ${origin}.`,
    );
  }
  return parsed;
}

function withHopTrace(error, hops, currentUrl) {
  if (!(error instanceof OutboundUrlPolicyError) || hops.length === 0) return error;
  return new OutboundUrlPolicyError(error.code, error.message, {
    ...error.details,
    currentUrl: currentUrl.href,
    completedHops: hops,
  });
}

function boundedOperation(operation, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new OutboundUrlPolicyError(
      'OUTBOUND_TIMEOUT',
      `${label} exceeded the ${timeoutMs}ms remaining timeout.`,
      { timeoutMs },
    )), timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(
        (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export async function fetchOriginBound(input, options) {
  if (!options || typeof options !== 'object') {
    throw new OutboundUrlPolicyError('OUTBOUND_POLICY_REQUIRED', 'An origin-bound outbound policy is required.');
  }
  const allowedPorts = normalizeAllowedPorts(options.allowedPorts);
  const origin = normalizeExactHttpOrigin(options.origin, { allowedPorts: [...allowedPorts] });
  const limits = {
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_OUTBOUND_FETCH_LIMITS.timeoutMs, 'timeoutMs'),
    maxBodyBytes: positiveInteger(options.maxBodyBytes, DEFAULT_OUTBOUND_FETCH_LIMITS.maxBodyBytes, 'maxBodyBytes'),
    maxRedirects: nonNegativeInteger(options.maxRedirects, DEFAULT_OUTBOUND_FETCH_LIMITS.maxRedirects, 'maxRedirects'),
  };
  const tlsRequestOptions = validatedTlsBypass(origin, options);
  const transport = options.transport ?? nativeTransport;
  let current = validatedRequestUrl(input instanceof URL ? input : new URL(String(input), origin), origin, allowedPorts);
  const hops = [];
  const startedAt = Date.now();
  let consumedBodyBytes = 0;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const remainingTimeoutMs = limits.timeoutMs - (Date.now() - startedAt);
    if (remainingTimeoutMs < 1) {
      throw new OutboundUrlPolicyError('OUTBOUND_TIMEOUT', `Request exceeded the ${limits.timeoutMs}ms total timeout.`, { hops });
    }
    let addresses;
    try {
      addresses = await boundedOperation(
        () => resolvePublicAddresses(current.hostname, { lookup: options.lookup }),
        remainingTimeoutMs,
        'DNS resolution',
      );
    } catch (error) {
      throw withHopTrace(error, hops, current);
    }
    const selected = addresses[0];
    const transportTimeoutMs = limits.timeoutMs - (Date.now() - startedAt);
    if (transportTimeoutMs < 1) {
      throw new OutboundUrlPolicyError('OUTBOUND_TIMEOUT', `Request exceeded the ${limits.timeoutMs}ms total timeout.`, { hops });
    }
    let response;
    try {
      const transportRequest = {
        url: current,
        address: selected,
        resolvedAddresses: addresses,
        headers: SAFE_REQUEST_HEADERS,
        timeoutMs: transportTimeoutMs,
        maxBodyBytes: limits.maxBodyBytes - consumedBodyBytes,
        tlsRequestOptions,
      };
      response = await boundedOperation(() => transport(transportRequest), transportTimeoutMs, 'HTTP request');
    } catch (error) {
      if (error instanceof OutboundUrlPolicyError) throw withHopTrace(error, hops, current);
      throw new OutboundUrlPolicyError(
        'OUTBOUND_REQUEST_FAILED',
        `Request failed for ${current.href}.`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const remoteKey = ipKey(String(response?.remoteAddress ?? ''));
    if (!remoteKey || remoteKey !== ipKey(selected.address) || !isPublicIpAddress(String(response.remoteAddress))) {
      throw new OutboundUrlPolicyError(
        'OUTBOUND_REMOTE_ADDRESS_MISMATCH',
        `Connected address did not match the DNS-pinned public address for ${current.hostname}.`,
        { expectedAddress: selected.address, remoteAddress: response?.remoteAddress ?? null },
      );
    }
    const statusCode = Number(response.statusCode);
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw new OutboundUrlPolicyError('OUTBOUND_RESPONSE_INVALID', 'Outbound transport returned an invalid response status.');
    }
    const headers = normalizeResponseHeaders(response.headers);
    const body = normalizeBody(response.body, limits.maxBodyBytes - consumedBodyBytes);
    consumedBodyBytes += body.byteLength;
    const hop = Object.freeze({
      url: current.href,
      statusCode,
      resolvedAddresses: Object.freeze(addresses.map(({ address }) => address)),
      connectedAddress: String(response.remoteAddress),
      location: headers.location ?? null,
    });
    hops.push(hop);

    if (!REDIRECT_STATUSES.has(statusCode) || !headers.location) {
      return Object.freeze({
        url: current.href,
        statusCode,
        headers,
        body,
        text: body.toString('utf8'),
        redirects: Object.freeze(hops.slice(0, -1)),
        hops: Object.freeze(hops),
      });
    }
    if (redirectCount >= limits.maxRedirects) {
      throw new OutboundUrlPolicyError(
        'OUTBOUND_REDIRECT_LIMIT',
        `Request exceeded the ${limits.maxRedirects}-redirect limit.`,
        { hops },
      );
    }
    let destination;
    try {
      destination = new URL(headers.location, current);
    } catch {
      throw new OutboundUrlPolicyError('OUTBOUND_REDIRECT_INVALID', `Redirect from ${current.href} has an invalid Location header.`);
    }
    try {
      current = validatedRequestUrl(destination, origin, allowedPorts);
    } catch (error) {
      if (error instanceof OutboundUrlPolicyError) {
        throw new OutboundUrlPolicyError(error.code, error.message, {
          ...error.details,
          redirectFrom: current.href,
          redirectLocation: headers.location,
          redirectDestination: destination.href,
          completedHops: hops,
        });
      }
      throw error;
    }
  }
}

export function createOriginBoundFetcher(options) {
  const origin = normalizeExactHttpOrigin(options?.origin, { allowedPorts: options?.allowedPorts });
  const frozen = Object.freeze({ ...options, origin });
  return (input) => fetchOriginBound(input, frozen);
}
