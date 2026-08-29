import assert from 'node:assert/strict';
import { createSharedControlBrowserClient } from '../portal/public/shared-control-client.js';

const calls = [];
let operationReads = 0;
let publicationReads = 0;
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => name.toLowerCase() === 'location' ? body?.data?.statusUrl ?? null : null },
  json: async () => body,
});
const client = createSharedControlBrowserClient({
  fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/control/v1/session' && options.method === 'POST') {
      return jsonResponse(200, { schemaVersion: 1, data: { csrfToken: 'csrf-memory-only', principal: { id: 'reviewer-1' } } });
    }
    if (String(url).endsWith('/publication')) {
      publicationReads += 1;
      return jsonResponse(200, { schemaVersion: 1, data: { runRevision: publicationReads === 1 ? 6 : 7, decision: { mode: 'comparative' }, riskRegister: { availability: 'PARTIAL', risks: [] } } });
    }
    if (String(url).endsWith('/executions')) return jsonResponse(200, { schemaVersion: 1, data: { runRevision: 7, executions: [{ id: 'work-incomplete', state: 'incomplete' }] } });
    if (String(url).includes('/logs?')) return jsonResponse(200, { schemaVersion: 1, data: { runId: 'run-1', runRevision: 7, limit: 200, truncated: false, events: [], attemptLogs: [] } });
    if (String(url).endsWith('/rekick')) return jsonResponse(202, { schemaVersion: 1, data: { operationId: 'a'.repeat(64), state: 'accepted', statusUrl: `/api/control/v1/runs/run-1/operations/${'a'.repeat(64)}` } });
    if (String(url).includes('/operations/')) {
      operationReads += 1;
      return jsonResponse(200, { schemaVersion: 1, data: operationReads === 1
        ? { operationId: 'a'.repeat(64), state: 'accepted' }
        : { operationId: 'a'.repeat(64), state: 'completed', outcome: { status: 'succeeded' } } });
    }
    throw new Error(`Unexpected request ${url}`);
  },
  wait: async () => {},
});

const credential = 'amt.fixture.secret-that-must-not-persist';
await client.login(credential);
assert.equal(client.session.csrfToken, 'csrf-memory-only');
assert.equal(JSON.parse(calls[0].options.body).credential, credential);
assert.equal(JSON.stringify(client.session).includes(credential), false);

const workspace = await client.readWorkspace('run-1');
assert.equal(workspace.publication.runRevision, 7);
assert.equal(workspace.executions.runRevision, 7);
assert.equal(workspace.riskAvailability, 'PARTIAL');
assert.equal(workspace.logs.limit, 200);
assert.equal(publicationReads, 2);

const accepted = await client.mutate('run-1', 'rekick', {
  expectedRunRevision: 7,
  body: { expectedSubjectDigest: `sha256:${'b'.repeat(64)}`, workItemIds: ['work-incomplete'] },
  requestId: 'rekick-browser-0001',
});
const mutation = calls.find(({ url }) => String(url).endsWith('/rekick'));
assert.equal(mutation.options.headers['X-Audit-CSRF'], 'csrf-memory-only');
assert.equal(mutation.options.headers['Idempotency-Key'], 'rekick-browser-0001');
assert.deepEqual(JSON.parse(mutation.options.body).workItemIds, ['work-incomplete']);
await assert.rejects(client.waitForOperation(`/api/control/v1/runs/another-run/operations/${'a'.repeat(64)}`, { runId: 'run-1' }), /another run/i);
const completed = await client.waitForOperation(accepted.statusUrl, { runId: 'run-1', maxPolls: 3, pollMs: 0 });
assert.equal(completed.outcome.status, 'succeeded');
assert.equal(operationReads, 2);
assert.equal(JSON.stringify(calls.slice(1)).includes(credential), false);

console.log('Shared control browser client self-test passed.');
