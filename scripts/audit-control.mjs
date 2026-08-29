#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { readCredentialFile } from './lib/credential-file.mjs';
import { CONTROL_EXIT_CODES, controlExitCode } from '../shared/control-client-contract.mjs';

await main().catch((error) => {
  const code = typeof error?.code === 'string' ? error.code : 'AUDIT_CONTROL_REQUEST_FAILED';
  const message = safeMessage(error?.message ?? error);
  writeJson({ schemaVersion: 1, error: { code, message } });
  process.stderr.write(`[audit-control] ${code}: ${message}\n`);
  process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : CONTROL_EXIT_CODES.REQUEST_FAILED;
});

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (options.token) throw usage('Use --token-file; command-line secrets are refused.');
  if (!options.tokenFile) throw usage('--token-file is required.', 'AUDIT_CONTROL_AUTH_REQUIRED');
  const base = new URL(options.server ?? process.env.AUDIT_CONTROL_URL ?? 'http://127.0.0.1:4173');
  const token = await readCredentialFile(options.tokenFile, { label: 'Control credential' });
  const run = options.run ? encodeURIComponent(options.run) : null;
  if (['operation', 'wait-operation'].includes(command)
    && !options.operationId && (!options.kind || !options.requestId)) {
    throw usage('operation lookup requires --operation-id or both --kind and --request-id.');
  }
  const routes = routesFor(run, options);
  if (!routes[command]) throw usage(`Unknown command ${command}.`);
  if (command !== 'launch' && (!options.run || options.run === 'undefined')) throw usage('--run is required.');
  const [method, pathname] = routes[command];
  if (method === 'POST' && !options.requestId) throw usage('--request-id is required for retry-safe mutations.');
  const body = options.body ? await readBody(options.body) : {};
  const maximumPolls = integer(options.maxPolls ?? '600', 1, 10_000, '--max-polls');
  const pollMs = integer(options.pollMs ?? '1000', 100, 60_000, '--poll-ms');
  const polling = command === 'watch' || command === 'wait-operation' || (command === 'logs' && options.follow === 'true');
  let reachedTerminal = false;
  for (let poll = 1; poll <= (polling ? maximumPolls : 1); poll += 1) {
    const { response, document, validJson } = await request(base, token, options.requestId, method, pathname, body);
    writeJson(document);
    if (!response.ok || !validJson) {
      process.stderr.write(`[audit-control] ${response.status} ${document.error?.code ?? 'REQUEST_FAILED'}: ${safeMessage(document.error?.message ?? response.statusText)}\n`);
      process.exitCode = validJson
        ? controlExitCode({ status: response.status, code: document.error?.code })
        : CONTROL_EXIT_CODES.REQUEST_FAILED;
      break;
    }
    if (command === 'watch' && terminal(document.data)) { reachedTerminal = true; break; }
    if (command === 'wait-operation' && document.data?.state === 'completed') {
      reachedTerminal = true;
      if (document.data.outcome?.status !== 'succeeded') {
        process.stderr.write(`[audit-control] operation failed: ${document.data.outcome?.code ?? 'CONTROL_OPERATION_FAILED'}\n`);
        process.exitCode = controlExitCode({ status: 409, code: document.data.outcome?.code });
      }
      break;
    }
    if (poll < maximumPolls && polling) await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (polling && !reachedTerminal && !process.exitCode) {
    process.stderr.write(`[audit-control] ${command} did not reach a terminal state within the polling bound.\n`);
    process.exitCode = CONTROL_EXIT_CODES.TIMEOUT;
  }
}

function routesFor(run, options) {
  return {
    launch: ['POST', '/api/control/v1/runs'],
    watch: ['GET', `/api/control/v1/runs/${run}`],
    publication: ['GET', `/api/control/v1/runs/${run}/publication`],
    executions: ['GET', `/api/control/v1/runs/${run}/executions`],
    logs: ['GET', `/api/control/v1/runs/${run}/logs?limit=${encodeURIComponent(options.limit ?? '200')}`],
    operation: ['GET', operationPath(run, options)],
    'wait-operation': ['GET', operationPath(run, options)],
    cancel: ['POST', `/api/control/v1/runs/${run}/cancel`],
    rekick: ['POST', `/api/control/v1/runs/${run}/rekick`],
    'risk-acknowledge': ['POST', `/api/control/v1/runs/${run}/risks/acknowledge`],
    'risk-resolve': ['POST', `/api/control/v1/runs/${run}/risks/resolve`],
    'visual-disposition': ['POST', `/api/control/v1/runs/${run}/visual/disposition`],
    purge: ['POST', `/api/control/v1/runs/${run}/purge`],
    'assert-release': ['POST', `/api/control/v1/runs/${run}/release/assert`],
    'consume-promotion': ['POST', `/api/control/v1/runs/${run}/promotion/consume`],
  };
}

async function readBody(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Body must be a JSON object.');
    return value;
  } catch (error) {
    throw usage(`--body is invalid: ${safeMessage(error.message)}`);
  }
}

async function request(base, token, requestId, method, pathname, body) {
  const response = await fetch(new URL(pathname, base), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': requestId } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  let document;
  let validJson = true;
  try { document = await response.json(); } catch {
    validJson = false;
    document = { schemaVersion: 1, error: { code: 'INVALID_RESPONSE', message: 'Server did not return JSON.' } };
  }
  return { response, document, validJson };
}

function terminal(data) {
  return data?.status === 'cancelled'
    || (data?.workItems && Object.values(data.workItems)
      .every((item) => ['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)));
}

function operationPath(runId, values) {
  if (values.operationId) return `/api/control/v1/runs/${runId}/operations/${encodeURIComponent(values.operationId)}`;
  return `/api/control/v1/runs/${runId}/operations?kind=${encodeURIComponent(values.kind ?? '')}&requestId=${encodeURIComponent(values.requestId ?? '')}`;
}

function integer(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw usage(`${label} is invalid.`);
  return parsed;
}

function parse(argv) {
  const command = argv.shift();
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw usage(`Invalid option ${argv[index] ?? ''}.`);
    options[argv[index].slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = argv[index + 1];
  }
  return { command, options };
}

function usage(message, code = 'AUDIT_CONTROL_USAGE') {
  return Object.assign(new Error(message), { code, exitCode: CONTROL_EXIT_CODES.USAGE });
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeMessage(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, 1_024);
}
