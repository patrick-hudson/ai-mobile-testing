import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chromium } from '@playwright/test';
import {
  startBrowserEgressProxy,
  trackBrowserEgressSocket,
} from './lib/browser-egress-proxy.mjs';

const events = [];
const resolutions = new Map();
const lookup = async (hostname) => {
  const count = (resolutions.get(hostname) ?? 0) + 1;
  resolutions.set(hostname, count);
  if (hostname === 'rebind.audit.test' && count === 1) return [{ address: '93.184.216.34', family: 4 }];
  if (hostname === 'rebind.audit.test') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'private.audit.test') return [{ address: '10.0.0.8', family: 4 }];
  if (hostname === 'metadata.audit.test') return [{ address: '169.254.169.254', family: 4 }];
  return [{ address: '127.0.0.1', family: 4 }];
};

{
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
    socket.emit('close');
  };
  const sockets = new Set();
  trackBrowserEgressSocket(socket, sockets, {
    emit: (event, detail = {}) => events.push({ event, detail }),
  });
  socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  assert.equal(socket.destroyed, true, 'browser-side socket failures are contained by destroying the failed socket');
  assert.equal(sockets.size, 0, 'failed browser sockets are removed from the tracked shutdown set');
  assert(events.some(({ event, detail }) => event === 'browser-egress-denied'
    && detail.code === 'ECONNRESET' && detail.direction === 'browser-to-proxy'),
  'browser-side socket failures are retained as structured diagnostics instead of crashing the worker');
}

const proxy = await startBrowserEgressProxy({
  lookup,
  requestTimeoutMs: 250,
  logger: { emit: (event, detail = {}) => events.push({ event, detail }) },
});
let browser;
try {
  browser = await chromium.launch({ headless: true, proxy: { server: proxy.url } });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('data:text/html,<title>egress fixture</title>');
  const subresource = await page.evaluate(async () => {
    const image = new Image();
    const completed = new Promise((resolve) => {
      image.onload = () => resolve('loaded');
      image.onerror = () => resolve('blocked');
    });
    image.src = 'http://metadata.audit.test/latest/meta-data/iam';
    document.body.append(image);
    return await completed;
  });
  assert.equal(subresource, 'blocked', 'metadata-address subresources are blocked by the browser proxy');

  const privateResponse = await page.goto('http://private.audit.test/', { waitUntil: 'commit', timeout: 2_000 });
  assert.equal(privateResponse?.status(), 403, 'browser navigation to a private DNS result receives the proxy denial');

  await page.setContent('<a id="redirect" href="http://private.audit.test/redirect-destination">redirect</a>');
  const [redirectResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'commit', timeout: 2_000 }),
    page.locator('#redirect').click(),
  ]);
  assert.equal(redirectResponse?.status(), 403, 'redirect/navigation destination receives the proxy denial');

  await page.goto('http://rebind.audit.test/', { waitUntil: 'commit', timeout: 2_000 }).catch(() => null);
  await page.goto('http://rebind.audit.test/', { waitUntil: 'commit', timeout: 2_000 }).catch(() => null);
  assert((resolutions.get('rebind.audit.test') ?? 0) >= 2, 'the browser retried the hostname and exercised the changed DNS answer');
  assert(events.some(({ event, detail }) => event === 'browser-egress-denied'
    && detail.code === 'OUTBOUND_ADDRESS_DENIED'), 'a later private DNS answer is denied instead of reusing public trust');

  assert(events.some(({ event, detail }) => event === 'browser-egress-denied'
    && detail.code === 'OUTBOUND_ADDRESS_DENIED'
    && /non-public address/i.test(detail.message)), 'denials are visible in structured worker logs');
  assert(events.some(({ event }) => event === 'browser-egress-request'), 'public DNS resolution reached the pinned connection attempt');
  await context.close();
  await browser.close();
  browser = null;
  console.log('Browser egress proxy self-test passed: browser navigation, redirect destinations, subresources, metadata addresses, and DNS rebinding fail closed.');
} finally {
  await browser?.close();
  await proxy.close();
}
