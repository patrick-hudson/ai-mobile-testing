#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { readCredentialFile } from './lib/credential-file.mjs';

const { command, options } = parse(process.argv.slice(2));
const base = new URL(options.server ?? process.env.AUDIT_CONTROL_URL ?? 'http://127.0.0.1:4173');
if (options.token) fail('AUDIT_CONTROL_USAGE', 'Use --token-file; command-line secrets are refused.', 2);
if (!options.tokenFile) fail('AUDIT_CONTROL_AUTH_REQUIRED', '--token-file is required.', 2);
const token = await readCredentialFile(options.tokenFile, { label: 'Control credential' });
const run = options.run ? encodeURIComponent(options.run) : null;
const routes = {
  launch: ['POST', '/api/control/v1/runs'],
  watch: ['GET', `/api/control/v1/runs/${run}`],
  executions: ['GET', `/api/control/v1/runs/${run}/executions`],
  logs: ['GET', `/api/control/v1/runs/${run}/logs?limit=${encodeURIComponent(options.limit ?? '200')}`],
  operation: ['GET', `/api/control/v1/runs/${run}/operations?kind=${encodeURIComponent(options.kind ?? '')}&requestId=${encodeURIComponent(options.requestId ?? '')}`],
  cancel: ['POST', `/api/control/v1/runs/${run}/cancel`],
  rekick: ['POST', `/api/control/v1/runs/${run}/rekick`],
  'risk-acknowledge': ['POST', `/api/control/v1/runs/${run}/risks/acknowledge`],
  'risk-resolve': ['POST', `/api/control/v1/runs/${run}/risks/resolve`],
  'visual-disposition': ['POST', `/api/control/v1/runs/${run}/visual/disposition`],
  purge: ['POST', `/api/control/v1/runs/${run}/purge`],
  'assert-release': ['POST', `/api/control/v1/runs/${run}/release/assert`],
  'consume-promotion': ['POST', `/api/control/v1/runs/${run}/promotion/consume`],
};
if (!routes[command]) fail('AUDIT_CONTROL_USAGE', `Unknown command ${command}.`, 2);
if (command !== 'launch' && (!options.run || options.run === 'undefined')) fail('AUDIT_CONTROL_USAGE', '--run is required.', 2);
const [method, pathname] = routes[command];
const body = options.body ? JSON.parse(await readFile(options.body, 'utf8')) : {};
const maximumPolls = integer(options.maxPolls ?? '600', 1, 10_000, '--max-polls');
const pollMs = integer(options.pollMs ?? '1000', 100, 60_000, '--poll-ms');
for (let poll = 1; poll <= (['watch'].includes(command) || (command === 'logs' && options.follow === 'true') ? maximumPolls : 1); poll += 1) {
  const { response, document } = await request(method, pathname, body);
  process.stdout.write(`${JSON.stringify(document)}\n`);
  if (!response.ok) {
    process.stderr.write(`[audit-control] ${response.status} ${document.error?.code ?? 'REQUEST_FAILED'}: ${document.error?.message ?? response.statusText}\n`);
    process.exitCode = exitClass(response.status, document.error?.code);
    break;
  }
  if (command === 'watch' && terminal(document.data)) break;
  if (poll < maximumPolls && (command === 'watch' || (command === 'logs' && options.follow === 'true'))) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
async function request(method, pathname, body) {
  const response = await fetch(new URL(pathname, base), {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': options.requestId ?? `cli-${crypto.randomUUID()}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const document = await response.json().catch(() => ({ error: { code: 'INVALID_RESPONSE', message: 'Server did not return JSON.' } }));
  return { response, document };
}
function terminal(data) { return data?.status === 'cancelled' || (data?.workItems && Object.values(data.workItems).every((item) => ['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state))); }
function exitClass(status, code = '') {
  if (/NOT_READY|PROMOTION_NOT_READY/.test(code)) return 10;
  if (/STALE|SUPERSEDED|REPLAYED|EXPIRED/.test(code)) return 11;
  if (/SCOPE|SUBJECT|AUTHORITY|EXECUTION_SET/.test(code)) return 12;
  if (/EMPTY|UNAVAILABLE/.test(code)) return 13;
  return status === 401 || status === 403 ? 3 : status === 409 ? 4 : 1;
}
function integer(value, minimum, maximum, label) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail('AUDIT_CONTROL_USAGE', `${label} is invalid.`, 2); return parsed; }
function parse(argv) {
  const command = argv.shift(); const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) fail('AUDIT_CONTROL_USAGE', `Invalid option ${argv[index] ?? ''}.`, 2);
    options[argv[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
  }
  return { command, options };
}
function fail(code, message, exitCode) { process.stdout.write(`${JSON.stringify({ schemaVersion: 1, error: { code, message } })}\n`); process.stderr.write(`[audit-control] ${message}\n`); process.exit(exitCode); }
