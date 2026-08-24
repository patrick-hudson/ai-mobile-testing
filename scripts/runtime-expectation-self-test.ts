import assert from 'node:assert/strict';
import {
  classifyExpectedThirdPartyTelemetryDiagnostic,
  expectedResponseConsoleDerivative,
  expectedThirdPartyTelemetryResponseDiagnostic,
} from '../fixtures/test.js';
import type { AuditEvidenceRecord, AuditRuntimeExpectation } from '../audit/types.js';

const target = 'https://beta.quitting7oh-org.pages.dev/__visual-audit-not-found__';
const expected404: AuditRuntimeExpectation = {
  kind: 'response-status',
  target,
  expected: 404,
  matched: true,
};

assert.equal(expectedResponseConsoleDerivative({
  text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
  locationUrl: target,
}, [expected404]), expected404);
assert.equal(expectedResponseConsoleDerivative({
  text: `GET ${target} [HTTP/2 404  21ms]`,
  locationUrl: target,
}, [expected404]), expected404);

for (const [label, event, expectations] of [
  ['unmatched declaration', { text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', locationUrl: target }, [{ ...expected404, matched: false }]],
  ['wrong target', { text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', locationUrl: `${target}-other` }, [expected404]],
  ['wrong status', { text: 'Failed to load resource: the server responded with a status of 500 (Server Error)', locationUrl: target }, [expected404]],
  ['arbitrary application console error', { text: 'Application failed while displaying status 404', locationUrl: target }, [expected404]],
  ['missing source location', { text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', locationUrl: null }, [expected404]],
] as const) {
  assert.equal(expectedResponseConsoleDerivative(event, expectations), null, label);
}

const cloudflareResponse: AuditEvidenceRecord['httpResponses'][number] = {
  url: 'https://cloudflareinsights.com/cdn-cgi/rum',
  method: 'POST',
  resourceType: 'xhr',
  status: 404,
  contentType: 'text/html',
  fromServiceWorker: false,
  firstParty: false,
};
const googleTagResponse: AuditEvidenceRecord['httpResponses'][number] = {
  url: 'https://www.googletagmanager.com/gtag/js?id=G-1ZPHE0EXTM',
  method: 'GET',
  resourceType: 'script',
  status: 200,
  contentType: 'application/javascript',
  fromServiceWorker: false,
  firstParty: false,
};
const telemetryResponses = [cloudflareResponse, googleTagResponse];

for (const [label, event, provider] of [
  ['Chromium CORS root', {
    text: "Access to XMLHttpRequest at 'https://cloudflareinsights.com/cdn-cgi/rum' from origin 'https://beta.quitting7oh-org.pages.dev' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    sourceUrl: 'https://beta.quitting7oh-org.pages.dev/',
    surface: 'console-error' as const,
  }, 'cloudflare-rum'],
  ['Chromium source-bound derivative', {
    text: 'Failed to load resource: net::ERR_FAILED',
    sourceUrl: 'https://cloudflareinsights.com/cdn-cgi/rum',
    surface: 'console-error' as const,
  }, 'cloudflare-rum'],
  ['WebKit access-control page error', {
    text: '/cloudflareinsights.com/cdn-cgi/rum due to access control checks.',
    sourceUrl: null,
    surface: 'page-error' as const,
  }, 'cloudflare-rum'],
  ['Firefox CORS wrapper', {
    text: '[JavaScript Error: "Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at https://cloudflareinsights.com/cdn-cgi/rum. (Reason: CORS header ‘Access-Control-Allow-Origin’ missing). Status code: 404."]',
    sourceUrl: 'https://beta.quitting7oh-org.pages.dev/',
    surface: 'console-error' as const,
  }, 'cloudflare-rum'],
  ['Firefox GA cookie diagnostic', {
    text: '[JavaScript Error: "Cookie “_ga_1ZPHE0EXTM” has been rejected for invalid domain." {file: "https://beta.quitting7oh-org.pages.dev/" line: 0}]',
    sourceUrl: 'https://beta.quitting7oh-org.pages.dev/',
    surface: 'console-error' as const,
  }, 'google-analytics'],
] as const) {
  assert.equal(
    classifyExpectedThirdPartyTelemetryDiagnostic(event, telemetryResponses)?.provider,
    provider,
    label,
  );
}

for (const [label, event] of [
  ['Chromium endpoint-naming root without response event', {
    text: "Access to resource at 'https://cloudflareinsights.com/cdn-cgi/rum' from origin 'https://beta.quitting7oh-org.pages.dev' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    sourceUrl: 'https://beta.quitting7oh-org.pages.dev/',
    surface: 'console-error' as const,
  }],
  ['Chromium exact endpoint-bound derivative without response event', {
    text: 'Failed to load resource: net::ERR_FAILED',
    sourceUrl: 'https://cloudflareinsights.com/cdn-cgi/rum',
    surface: 'console-error' as const,
  }],
  ['WebKit endpoint-naming native error without response event', {
    text: '/cloudflareinsights.com/cdn-cgi/rum due to access control checks.',
    sourceUrl: null,
    surface: 'page-error' as const,
  }],
  ['WebKit endpoint-naming beacon error without response event', {
    text: 'Beacon API cannot load https://cloudflareinsights.com/cdn-cgi/rum. Origin https://beta.quitting7oh-org.pages.dev is not allowed by Access-Control-Allow-Origin. Status code: 404',
    sourceUrl: null,
    surface: 'console-error' as const,
  }],
] as const) {
  assert.deepEqual(
    classifyExpectedThirdPartyTelemetryDiagnostic(event, []),
    {
      provider: 'cloudflare-rum',
      surface: event.surface,
      message: event.text,
      sourceUrl: event.sourceUrl,
      status: null,
    },
    label,
  );
}

for (const [label, event, responses] of [
  ['unrelated generic resource failure', {
    text: 'Failed to load resource: net::ERR_FAILED',
    sourceUrl: 'https://beta.quitting7oh-org.pages.dev/app.js',
    surface: 'console-error' as const,
  }, telemetryResponses],
  ['source-less generic resource failure without endpoint evidence', {
    text: 'Failed to load resource: net::ERR_FAILED',
    sourceUrl: null,
    surface: 'console-error' as const,
  }, [googleTagResponse]],
  ['near-miss Cloudflare host', {
    text: 'Failed to load resource: net::ERR_FAILED',
    sourceUrl: 'https://cloudflareinsights.example/cdn-cgi/rum',
    surface: 'console-error' as const,
  }, [cloudflareResponse]],
  ['first-party application exception', {
    text: 'TypeError: Cannot read properties of undefined',
    sourceUrl: 'https://beta.quitting7oh-org.pages.dev/app.js',
    surface: 'page-error' as const,
  }, telemetryResponses],
  ['near-miss GA application message', {
    text: 'Application says Cookie “_ga” has been rejected for invalid domain.',
    sourceUrl: 'https://beta.quitting7oh-org.pages.dev/app.js',
    surface: 'console-error' as const,
  }, telemetryResponses],
] as const) {
  assert.equal(classifyExpectedThirdPartyTelemetryDiagnostic(event, responses), null, label);
}

for (const text of [
  'Origin https://beta.quitting7oh-org.pages.dev is not allowed by Access-Control-Allow-Origin. Status code: 404',
  'Failed to load resource: Origin https://beta.quitting7oh-org.pages.dev is not allowed by Access-Control-Allow-Origin. Status code: 404',
]) {
  const event = { text, sourceUrl: null, surface: 'console-error' as const };
  assert.equal(
    classifyExpectedThirdPartyTelemetryDiagnostic(event, []),
    null,
    'A source-less WebKit derivative must not be classified without causal Cloudflare evidence',
  );
  assert.equal(
    classifyExpectedThirdPartyTelemetryDiagnostic(event, [], { cloudflareRumCausallyObserved: true })?.provider,
    'cloudflare-rum',
    'An exact WebKit derivative may be classified after the same run proves the Cloudflare RUM failure',
  );
}

assert.deepEqual(expectedThirdPartyTelemetryResponseDiagnostic(cloudflareResponse), {
  provider: 'cloudflare-rum',
  surface: 'http-response',
  message: 'POST 404 https://cloudflareinsights.com/cdn-cgi/rum',
  sourceUrl: 'https://cloudflareinsights.com/cdn-cgi/rum',
  status: 404,
});
assert.equal(expectedThirdPartyTelemetryResponseDiagnostic({
  ...cloudflareResponse,
  url: 'https://beta.quitting7oh-org.pages.dev/cdn-cgi/rum',
  firstParty: true,
}), null, 'first-party errors never become telemetry diagnostics');

process.stdout.write('Runtime expectation self-test passed: exact first-party expected errors and causally proven third-party telemetry are classified narrowly; unrelated runtime defects remain failures.\n');
