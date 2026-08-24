import assert from 'node:assert/strict';
import { expectedResponseConsoleDerivative } from '../fixtures/test.js';
import type { AuditRuntimeExpectation } from '../audit/types.js';

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

process.stdout.write('Runtime expectation self-test passed: native browser errors are suppressed only after an exact first-party status expectation is causally consumed.\n');
