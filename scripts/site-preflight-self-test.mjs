import assert from 'node:assert/strict';
import {
  OutboundUrlPolicyError,
  createPinnedLookup,
  fetchOriginBound,
  isPublicIpAddress,
  normalizeExactHttpOrigin,
  resolvePublicAddresses,
} from '../shared/outbound-url-policy.mjs';
import { preflightQuitting7ohSite } from '../shared/site-preflight.mjs';

const origin = 'https://audit.example';
const publicAddress = '93.184.216.34';
const fixedNow = () => new Date('2026-08-25T12:00:00.000Z');
const rootHtml = `<!doctype html>
<html><head>
  <meta property="og:site_name" content="quitting7oh.org">
  <link rel="manifest" href="/favicons/stone/site.webmanifest">
  <link rel="stylesheet" href="/_astro/site.abc123.css">
  <script type="module" src="/_astro/page.def456.js"></script>
</head><body><main id="main-content"><h1>Help quitting <span>7-OH</span></h1></main></body></html>`;
const sentinelHtml = `<!doctype html><html><head>
  <meta property="og:site_name" content="quitting7oh.org">
</head><body><main id="main-content"><h1>Welcome</h1><p><strong>You’re in the right place.</strong></p></main></body></html>`;
const manifestJson = JSON.stringify({ name: 'quitting7oh.org', short_name: 'quitting7oh', display: 'standalone' });

function fakeSite(overrides = {}) {
  const calls = [];
  const revision = overrides.revision === undefined ? 'commit-a1b2c3' : overrides.revision;
  const responses = new Map([
    ['/', {
      statusCode: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        etag: '"root-etag"',
        ...(revision ? { 'cf-pages-commit-sha': revision } : {}),
      },
      body: overrides.rootHtml ?? rootHtml,
    }],
    ['/favicons/stone/site.webmanifest', {
      statusCode: 200,
      headers: { 'content-type': 'application/manifest+json', etag: '"manifest-etag"' },
      body: overrides.manifestJson ?? manifestJson,
    }],
    ['/start-here/welcome', {
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', etag: '"sentinel-etag"' },
      body: overrides.sentinelHtml ?? sentinelHtml,
    }],
  ]);
  const transport = async (request) => {
    calls.push(request);
    const response = responses.get(request.url.pathname);
    if (!response) return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'missing', remoteAddress: publicAddress };
    return { ...response, remoteAddress: overrides.remoteAddress ?? request.address.address };
  };
  return { calls, transport };
}

const publicLookup = async () => [{ address: publicAddress, family: 4 }];

{
  const lookup = createPinnedLookup({ address: publicAddress, family: 4 });
  await new Promise((resolve, reject) => lookup('audit.example', { all: true }, (error, addresses) => {
    if (error) return reject(error);
    assert.deepEqual(addresses, [{ address: publicAddress, family: 4 }]);
    resolve();
  }));
  await new Promise((resolve, reject) => lookup('audit.example', {}, (error, address, family) => {
    if (error) return reject(error);
    assert.equal(address, publicAddress);
    assert.equal(family, 4);
    resolve();
  }));
}

assert.equal(isPublicIpAddress(publicAddress), true);
for (const address of [
  '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
  '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::', '::1',
  '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1',
]) assert.equal(isPublicIpAddress(address), false, `${address} must not be treated as public`);
assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);

assert.equal(normalizeExactHttpOrigin(`${origin}/`), origin);
assert.throws(() => normalizeExactHttpOrigin('https://user:secret@audit.example'), /credentials/);
assert.throws(() => normalizeExactHttpOrigin(`${origin}/path`), /exact origin/);
assert.throws(() => normalizeExactHttpOrigin('https://audit.example:8443'), /disallowed port/);
assert.throws(() => normalizeExactHttpOrigin('https://audit.example:80'), /disallowed port/);
await assert.rejects(
  fetchOriginBound('https://user:secret@audit.example/', {
    origin,
    lookup: publicLookup,
    transport: async () => assert.fail('Credentialed URL must fail before transport.'),
  }),
  (error) => error instanceof OutboundUrlPolicyError && error.code === 'OUTBOUND_CREDENTIALS_DENIED',
);
await assert.rejects(
  resolvePublicAddresses('audit.example', { lookup: async () => [
    { address: publicAddress, family: 4 },
    { address: '127.0.0.1', family: 4 },
  ] }),
  (error) => error instanceof OutboundUrlPolicyError && error.code === 'OUTBOUND_ADDRESS_DENIED',
  'A mixed public/private DNS answer must fail closed rather than selecting only the public result.',
);

{
  const seen = [];
  const response = await fetchOriginBound('/first', {
    origin,
    lookup: publicLookup,
    transport: async (request) => {
      seen.push(request);
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers['proxy-authorization'], undefined);
      return request.url.pathname === '/first'
        ? { statusCode: 302, headers: { location: '/second' }, body: '', remoteAddress: request.address.address }
        : { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'done', remoteAddress: request.address.address };
    },
  });
  assert.equal(response.text, 'done');
  assert.equal(response.redirects.length, 1);
  assert.equal(seen.length, 2, 'Redirects must be followed manually as distinct pinned requests.');
}

await assert.rejects(
  fetchOriginBound('/escape', {
    origin,
    lookup: publicLookup,
    transport: async (request) => ({
      statusCode: 302,
      headers: { location: 'https://other.example/private' },
      body: '',
      remoteAddress: request.address.address,
    }),
  }),
  (error) => error instanceof OutboundUrlPolicyError && error.code === 'OUTBOUND_ORIGIN_DENIED',
  'Cross-origin redirects must be rejected before the destination is resolved or requested.',
);

{
  let lookups = 0;
  let requests = 0;
  await assert.rejects(
    fetchOriginBound('/rebind-start', {
      origin,
      lookup: async () => {
        lookups += 1;
        return [{ address: lookups === 1 ? publicAddress : '169.254.169.254', family: 4 }];
      },
      transport: async (request) => {
        requests += 1;
        return { statusCode: 302, headers: { location: '/rebind-finish' }, body: '', remoteAddress: request.address.address };
      },
    }),
    (error) => error instanceof OutboundUrlPolicyError && error.code === 'OUTBOUND_ADDRESS_DENIED',
  );
  assert.equal(lookups, 2, 'DNS must be resolved and checked again for a same-origin redirect hop.');
  assert.equal(requests, 1, 'The rebound private destination must never reach the transport.');
}

await assert.rejects(
  fetchOriginBound('/rebind-socket', {
    origin,
    lookup: publicLookup,
    transport: async () => ({ statusCode: 200, headers: {}, body: 'bad', remoteAddress: '127.0.0.1' }),
  }),
  (error) => error instanceof OutboundUrlPolicyError && error.code === 'OUTBOUND_REMOTE_ADDRESS_MISMATCH',
  'The connected socket address must match the DNS-pinned public address.',
);

await assert.rejects(
  fetchOriginBound('/large', {
    origin,
    lookup: publicLookup,
    maxBodyBytes: 8,
    transport: async (request) => ({ statusCode: 200, headers: {}, body: '123456789', remoteAddress: request.address.address }),
  }),
  (error) => error instanceof OutboundUrlPolicyError && error.code === 'OUTBOUND_BODY_LIMIT',
);

await assert.rejects(
  fetchOriginBound('/slow', {
    origin,
    lookup: publicLookup,
    timeoutMs: 15,
    transport: async () => new Promise(() => {}),
  }),
  (error) => error instanceof OutboundUrlPolicyError && error.code === 'OUTBOUND_TIMEOUT',
  'The overall request timeout must also contain an injected transport.',
);

{
  let requestCount = 0;
  await assert.rejects(
    fetchOriginBound('/body-one', {
      origin,
      lookup: publicLookup,
      maxBodyBytes: 8,
      transport: async (request) => {
        requestCount += 1;
        return requestCount === 1
          ? { statusCode: 302, headers: { location: '/body-two' }, body: '123456', remoteAddress: request.address.address }
          : { statusCode: 200, headers: {}, body: '789', remoteAddress: request.address.address };
      },
    }),
    (error) => error instanceof OutboundUrlPolicyError && error.code === 'OUTBOUND_BODY_LIMIT',
    'The byte ceiling must cover the full redirect chain, not each hop independently.',
  );
}

{
  let injectedOrigin = null;
  let observedTlsOptions = null;
  await fetchOriginBound('/', {
    origin,
    deploymentRole: 'preview',
    certificatePolicy: 'preview-bypass',
    previewBypassOrigins: [`${origin}/`],
    tlsBypassRequestOptions(requestOrigin) {
      injectedOrigin = requestOrigin;
      return { rejectUnauthorized: false };
    },
    lookup: publicLookup,
    transport: async (request) => {
      observedTlsOptions = request.tlsRequestOptions;
      return { statusCode: 200, headers: {}, body: 'ok', remoteAddress: request.address.address };
    },
  });
  assert.equal(injectedOrigin, origin, 'TLS request options are injected only after exact-origin authorization.');
  assert.deepEqual(observedTlsOptions, { rejectUnauthorized: false });
}

await assert.rejects(
  fetchOriginBound('/', {
    origin,
    deploymentRole: 'production',
    certificatePolicy: 'preview-bypass',
    previewBypassOrigins: [origin],
    tlsBypassRequestOptions: { rejectUnauthorized: false },
    lookup: publicLookup,
    transport: async () => assert.fail('Production TLS bypass must fail before transport.'),
  }),
  /only for Preview deployments/,
);
await assert.rejects(
  fetchOriginBound('/', {
    origin,
    deploymentRole: 'preview',
    certificatePolicy: 'preview-bypass',
    previewBypassOrigins: ['https://audit.example.evil.test'],
    tlsBypassRequestOptions: { rejectUnauthorized: false },
    lookup: publicLookup,
    transport: async () => assert.fail('Non-allowlisted TLS bypass must fail before transport.'),
  }),
  /exact Preview origin allowlist/,
);

const siteA = fakeSite();
const acceptedA = await preflightQuitting7ohSite({
  url: `${origin}/`,
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
}, { lookup: publicLookup, transport: siteA.transport, now: fixedNow });
assert.equal(acceptedA.accepted, true);
assert.equal(acceptedA.markers.length, 6);
assert.equal(acceptedA.markers.every(({ passed }) => passed), true);
assert.equal(acceptedA.probes.length, 3);
assert.equal(acceptedA.deploymentRevision.status, 'verified');
assert.equal(acceptedA.deploymentRevision.source, 'explicit-build-id');
assert.equal(acceptedA.evidenceAuthority.status, 'authoritative');
assert.match(acceptedA.identityFingerprint, /^[a-f0-9]{64}$/);
assert.match(acceptedA.deploymentRevision.fingerprint, /^[a-f0-9]{64}$/);
assert.match(acceptedA.preflightDigest, /^[a-f0-9]{64}$/);
assert.equal(siteA.calls.length, 3, 'Preview preflight performs only the three bounded, side-effect-free GET probes.');
assert.equal(siteA.calls.every((call) => call.headers.authorization === undefined && call.headers.cookie === undefined), true);

const siteASame = fakeSite();
const acceptedASame = await preflightQuitting7ohSite({
  url: origin,
  deploymentRole: 'preview',
}, { lookup: publicLookup, transport: siteASame.transport, now: () => new Date('2026-08-25T13:00:00.000Z') });
assert.equal(acceptedASame.preflightDigest, acceptedA.preflightDigest, 'Preview timestamps must not make revalidation drift.');

const siteB = fakeSite({ revision: 'commit-d4e5f6' });
const acceptedB = await preflightQuitting7ohSite({ url: origin, deploymentRole: 'preview' }, {
  lookup: publicLookup, transport: siteB.transport, now: fixedNow,
});
assert.equal(acceptedB.identityFingerprint, acceptedA.identityFingerprint, 'Reviewed site identity must remain stable across deployments.');
assert.notEqual(acceptedB.deploymentRevision.fingerprint, acceptedA.deploymentRevision.fingerprint, 'A new build identifier must change deployment revision.');
assert.notEqual(acceptedB.preflightDigest, acceptedA.preflightDigest, 'Launch revalidation must detect deployment revision changes.');

const wrongSite = fakeSite({ rootHtml: rootHtml.replace('quitting7oh.org', 'copied.example') });
const rejected = await preflightQuitting7ohSite({ url: origin, deploymentRole: 'preview' }, {
  lookup: publicLookup, transport: wrongSite.transport, now: fixedNow,
});
assert.equal(rejected.accepted, false);
assert.equal(rejected.identityFingerprint, null);
assert.equal(rejected.issues.some(({ code }) => code === 'PREFLIGHT_IDENTITY_MARKER_MISSING'), true);
assert.equal(rejected.evidenceAuthority.status, 'non-authoritative');
assert(rejected.evidenceAuthority.reasons.includes('preflight-rejected'));

// Remove validators too, making the limitation explicit rather than deriving a
// revision from a value observed from the deployment under test.
const noRevisionResult = await preflightQuitting7ohSite({ url: origin, deploymentRole: 'preview' }, {
  lookup: publicLookup,
  now: fixedNow,
  transport: async (request) => {
    const bodies = {
      '/': rootHtml.replace(/<link rel="stylesheet"[^>]+>/, '').replace(/<script[\s\S]*?<\/script>/, ''),
      '/favicons/stone/site.webmanifest': manifestJson,
      '/start-here/welcome': sentinelHtml,
    };
    return {
      statusCode: 200,
      headers: { 'content-type': request.url.pathname.endsWith('webmanifest') ? 'application/manifest+json' : 'text/html' },
      body: bodies[request.url.pathname],
      remoteAddress: request.address.address,
    };
  },
});
assert.equal(noRevisionResult.accepted, true, 'Missing revision evidence does not erase proven application identity.');
assert.equal(noRevisionResult.deploymentRevision.status, 'unavailable');
assert.equal(noRevisionResult.evidenceAuthority.status, 'non-authoritative');
assert.deepEqual(noRevisionResult.evidenceAuthority.reasons, ['deployment-revision-unavailable']);

const invalidInput = await preflightQuitting7ohSite({
  url: 'https://user:secret@audit.example',
  deploymentRole: 'preview',
}, { now: fixedNow });
assert.equal(invalidInput.accepted, false);
assert.equal(invalidInput.probes.length, 0, 'Rejected input must not perform any network work.');
assert.equal(invalidInput.issues[0].code, 'OUTBOUND_CREDENTIALS_DENIED');

process.stdout.write(
  'Site preflight self-test passed: exact-origin public DNS pinning, redirect/rebinding/body bounds, Preview-only TLS injection, independent identity markers, and deployment revision revalidation are enforced.\n',
);
