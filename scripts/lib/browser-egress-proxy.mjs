import http from 'node:http';
import https from 'node:https';
import net, { isIP } from 'node:net';
import { createPinnedLookup, isPublicIpAddress, resolvePublicAddresses } from '../../shared/outbound-url-policy.mjs';

const ALLOWED_PORTS = new Set([80, 443]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export class BrowserEgressPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrowserEgressPolicyError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new BrowserEgressPolicyError(code, message, details);
}

function parseDestination(value, { connect = false } = {}) {
  let parsed;
  try {
    parsed = connect ? new URL(`https://${value}`) : new URL(value);
  } catch {
    fail('BROWSER_EGRESS_URL_INVALID', 'Browser requested an invalid outbound destination.');
  }
  if ((!connect && !['http:', 'https:'].includes(parsed.protocol)) || parsed.username || parsed.password) {
    fail('BROWSER_EGRESS_DESTINATION_DENIED', 'Browser destination must be credential-free HTTP or HTTPS.');
  }
  if (connect && (parsed.pathname !== '/' || parsed.search || parsed.hash)) {
    fail('BROWSER_EGRESS_CONNECT_INVALID', 'Browser CONNECT authority is malformed.');
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (!ALLOWED_PORTS.has(port)) fail('BROWSER_EGRESS_PORT_DENIED', `Browser destination port ${port} is denied.`);
  return { parsed, port };
}

function filteredHeaders(headers, host) {
  const output = { host };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'host') continue;
    output[name] = value;
  }
  return output;
}

function comparableIp(address) {
  const value = String(address).toLowerCase().split('%', 1)[0];
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped) return mapped[1];
  if (isIP(value) === 6) {
    try { return new URL(`http://[${value}]`).hostname.slice(1, -1); } catch { return value; }
  }
  return value;
}

function connectedToPinnedAddress(remoteAddress, selectedAddress) {
  return isPublicIpAddress(remoteAddress) && comparableIp(remoteAddress) === comparableIp(selectedAddress);
}

function deny(socket, statusCode, message) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

function proxyError(logger, error, detail = {}) {
  logger?.emit?.('browser-egress-denied', {
    code: error?.code ?? 'BROWSER_EGRESS_FAILED',
    message: String(error?.message ?? error).slice(0, 1_000),
    ...detail,
  });
}

async function selectedPublicAddress(hostname, lookup) {
  const addresses = await resolvePublicAddresses(hostname, { lookup });
  if (addresses.length === 0) fail('BROWSER_EGRESS_DNS_EMPTY', `DNS returned no public addresses for ${hostname}.`);
  return { selected: addresses[0], addresses };
}

export async function startBrowserEgressProxy({
  lookup,
  logger,
  host = '127.0.0.1',
  requestTimeoutMs = 30_000,
} = {}) {
  if (host !== '127.0.0.1' && host !== '::1') fail('BROWSER_EGRESS_BIND_DENIED', 'Browser egress proxy must bind to loopback.');
  const sockets = new Set();
  const requests = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      const { parsed, port } = parseDestination(request.url ?? '');
      const { selected, addresses } = await selectedPublicAddress(parsed.hostname, lookup);
      logger?.emit?.('browser-egress-request', {
        method: request.method,
        url: parsed.href,
        resolvedAddresses: addresses.map(({ address }) => address),
        connectedAddress: selected.address,
      });
      const client = parsed.protocol === 'https:' ? https : http;
      const upstream = client.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port,
        method: request.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: filteredHeaders(request.headers, parsed.host),
        lookup: createPinnedLookup(selected),
        agent: false,
        ...(parsed.protocol === 'https:' && !isIP(parsed.hostname) ? { servername: parsed.hostname } : {}),
      }, (upstreamResponse) => {
        const remoteAddress = upstreamResponse.socket.remoteAddress ?? '';
        if (!connectedToPinnedAddress(remoteAddress, selected.address)) {
          upstreamResponse.destroy();
          response.writeHead(502, { connection: 'close' }).end();
          proxyError(logger, new BrowserEgressPolicyError(
            'BROWSER_EGRESS_REMOTE_MISMATCH',
            'Connected browser destination did not match its DNS-pinned public address.',
          ), { url: parsed.href, expectedAddress: selected.address, remoteAddress });
          return;
        }
        const headers = Object.fromEntries(Object.entries(upstreamResponse.headers)
          .filter(([name, value]) => value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())));
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        upstreamResponse.pipe(response);
      });
      requests.add(upstream);
      upstream.once('close', () => requests.delete(upstream));
      upstream.setTimeout(requestTimeoutMs, () => upstream.destroy(new Error('Browser egress request timed out.')));
      upstream.once('error', (error) => {
        proxyError(logger, error, { url: parsed.href });
        if (!response.headersSent) response.writeHead(502, { connection: 'close' });
        response.end();
      });
      request.pipe(upstream);
    } catch (error) {
      proxyError(logger, error, { url: String(request.url ?? '').slice(0, 2_000) });
      if (!response.headersSent) response.writeHead(403, { connection: 'close' });
      response.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', async (request, browserSocket, head) => {
    try {
      const { parsed, port } = parseDestination(request.url ?? '', { connect: true });
      const { selected, addresses } = await selectedPublicAddress(parsed.hostname, lookup);
      logger?.emit?.('browser-egress-connect', {
        hostname: parsed.hostname,
        port,
        resolvedAddresses: addresses.map(({ address }) => address),
        connectedAddress: selected.address,
      });
      const upstream = net.connect({ host: selected.address, port, family: selected.family });
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.setTimeout(requestTimeoutMs, () => upstream.destroy(new Error('Browser egress CONNECT timed out.')));
      upstream.once('connect', () => {
        const remoteAddress = upstream.remoteAddress ?? '';
        if (!connectedToPinnedAddress(remoteAddress, selected.address)) {
          proxyError(logger, new BrowserEgressPolicyError(
            'BROWSER_EGRESS_REMOTE_MISMATCH',
            'Connected browser tunnel did not match its DNS-pinned public address.',
          ), { hostname: parsed.hostname, expectedAddress: selected.address, remoteAddress });
          upstream.destroy();
          deny(browserSocket, 502, 'Bad Gateway');
          return;
        }
        browserSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: ai-mobile-testing-egress/1\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(browserSocket);
        browserSocket.pipe(upstream);
      });
      upstream.once('error', (error) => {
        proxyError(logger, error, { hostname: parsed.hostname });
        deny(browserSocket, 502, 'Bad Gateway');
      });
    } catch (error) {
      proxyError(logger, error, { authority: String(request.url ?? '').slice(0, 500) });
      deny(browserSocket, 403, 'Forbidden');
    }
  });
  server.on('upgrade', (request, socket) => {
    proxyError(logger, new BrowserEgressPolicyError(
      'BROWSER_EGRESS_UPGRADE_DENIED',
      'Protocol upgrades are denied because this proxy cannot preserve the audited request policy across them.',
    ), { url: String(request.url ?? '').slice(0, 2_000) });
    deny(socket, 403, 'Forbidden');
  });
  server.on('clientError', (_error, socket) => deny(socket, 400, 'Bad Request'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    fail('BROWSER_EGRESS_START_FAILED', 'Browser egress proxy did not publish a TCP address.');
  }
  const url = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
  logger?.emit?.('browser-egress-proxy-started', { url, allowedPorts: [...ALLOWED_PORTS] });
  return Object.freeze({
    url,
    async close() {
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 1_000);
        server.close((error) => {
          clearTimeout(timer);
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
      });
      logger?.emit?.('browser-egress-proxy-stopped');
    },
  });
}
