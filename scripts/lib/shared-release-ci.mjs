import { canonicalDigest, canonicalJson } from '../../shared/canonical-contract.mjs';
import { parseExecutionManifest } from '../../shared/execution-contract.mjs';
import { parsePublicationEnvelope } from '../../shared/publication-envelope.mjs';
import { parseFinalReleaseSubject } from '../../shared/release-subject.mjs';
import {
  probeTargetPreflightSet,
  targetPreflightInputsForRunContract,
  targetPreflightInputsForSubject,
} from '../../shared/target-preflight-set.mjs';

const TERMINAL_WORK_STATES = new Set([
  'completed_pass', 'completed_product_failure', 'cancelled', 'incomplete',
]);
const ACTIVE_WORK_STATES = new Set(['queued', 'running']);
const OPERATION_ID = /^[a-f0-9]{64}$/u;
const RUN_ID = /^run-[a-f0-9]{32}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

export class SharedReleaseCiError extends Error {
  constructor(code, message, cause = undefined, details = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SharedReleaseCiError';
    this.code = code;
    Object.assign(this, details);
  }
}

function exactBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Shared release CI server must be an exact HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Shared release CI server must be an exact HTTP(S) origin.');
  }
  return url;
}

async function boundedJson(response, maximumResponseBytes) {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
    fail('CI_HTTP_RESPONSE_TOO_LARGE', 'Control response exceeded the configured byte bound.');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('CI_HTTP_INVALID_RESPONSE', 'Control response had no readable body.');
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumResponseBytes) {
      await reader.cancel().catch(() => undefined);
      fail('CI_HTTP_RESPONSE_TOO_LARGE', 'Control response exceeded the configured byte bound.');
    }
    chunks.push(value);
  }
  let document;
  try { document = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')); }
  catch (error) { fail('CI_HTTP_INVALID_RESPONSE', 'Control response was not valid bounded JSON.', error); }
  if (!record(document) || document.schemaVersion !== 1) {
    fail('CI_HTTP_INVALID_RESPONSE', 'Control response did not use the supported response envelope.');
  }
  return document;
}

export function createSharedReleaseHttpClient({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  preflight,
  preflightOptions = {},
  timeoutMs = 15_000,
  maximumResponseBytes = 8 * 1_048_576,
  maximumRedirects = 3,
  maximumLaunchAttempts = 2,
} = {}) {
  const base = exactBaseUrl(baseUrl);
  if (typeof token !== 'string' || token.length < 40 || token.length > 4_096 || typeof fetchImpl !== 'function') {
    throw new TypeError('Shared release HTTP client requires a bounded credential and fetch implementation.');
  }
  positiveInteger(timeoutMs, 'timeoutMs');
  positiveInteger(maximumResponseBytes, 'maximumResponseBytes');
  positiveInteger(maximumRedirects, 'maximumRedirects', 0);
  positiveInteger(maximumLaunchAttempts, 'maximumLaunchAttempts');
  let launchIntent = null;

  async function once(method, pathname, { requestId, body } = {}) {
    let url = new URL(pathname, base);
    for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': requestId }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new SharedReleaseCiError('CI_HTTP_TRANSPORT_FAILED', 'Control request failed before a bounded response was received.', error);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) fail('CI_HTTP_INVALID_REDIRECT', 'Control response redirected without a Location header.');
        const redirected = new URL(location, url);
        if (redirected.origin !== base.origin) {
          fail('CI_HTTP_CROSS_ORIGIN_REDIRECT', 'Control response attempted to redirect credentials to another origin.');
        }
        if (redirect === maximumRedirects) fail('CI_HTTP_REDIRECT_LIMIT', 'Control response exceeded the redirect bound.');
        url = redirected;
        continue;
      }
      const document = await boundedJson(response, maximumResponseBytes);
      if (!response.ok || document.error) {
        const serverCode = typeof document.error?.code === 'string' ? document.error.code : 'REQUEST_FAILED';
        throw new SharedReleaseCiError(
          `CI_HTTP_${serverCode}`,
          String(document.error?.message ?? `Control request failed with HTTP ${response.status}.`)
            .replaceAll(token, '[REDACTED]').slice(0, 1_024),
          undefined,
          { status: response.status, serverCode },
        );
      }
      if (!('data' in document)) fail('CI_HTTP_INVALID_RESPONSE', 'Successful control response omitted data.');
      return document.data;
    }
    fail('CI_HTTP_REDIRECT_LIMIT', 'Control response exceeded the redirect bound.');
  }

  async function launch(input) {
    launchIntent = structuredClone(input.intent);
    let last;
    for (let attempt = 1; attempt <= maximumLaunchAttempts; attempt += 1) {
      try { return await once('POST', '/api/control/v1/runs', { requestId: input.requestId, body: input.intent }); }
      catch (error) {
        last = error;
        if (error?.code !== 'CI_HTTP_TRANSPORT_FAILED' || attempt === maximumLaunchAttempts) throw error;
      }
    }
    throw last;
  }

  return Object.freeze({
    launch,
    readLaunchOperation: ({ operationId }) => once('GET', `/api/control/v1/launch-operations/${encodeURIComponent(operationId)}`),
    readRun: ({ runId }) => once('GET', `/api/control/v1/runs/${encodeURIComponent(runId)}`),
    readPublication: ({ runId }) => once('GET', `/api/control/v1/runs/${encodeURIComponent(runId)}/publication`),
    async reprobeTargetIdentity({ targets }) {
      if (!launchIntent) fail('CI_TARGET_REPROBE_FAILED', 'Target reprobe cannot run before a launch intent is bound.');
      const contract = launchIntent.runContract;
      const intentInputs = targetPreflightInputsForRunContract(contract);
      const subjectInputs = targetPreflightInputsForSubject({
        mode: contract.mode, targets, certificatePolicy: contract.mode === 'single-site' ? contract.certificatePolicy : 'strict',
        singleSiteDeploymentRole: contract.mode === 'single-site' ? contract.deploymentRole : null,
      });
      const normalize = (values) => values.map(({ url, deploymentRole, certificatePolicy }) => ({
        url: new URL(url).origin, deploymentRole, certificatePolicy,
      })).sort((left, right) => left.deploymentRole.localeCompare(right.deploymentRole) || left.url.localeCompare(right.url));
      if (canonicalJson(normalize(intentInputs)) !== canonicalJson(normalize(subjectInputs))) {
        fail('CI_TARGET_SUBJECT_MISMATCH', 'Launched intent targets do not exactly match the sealed final subject.');
      }
      const bypassOptions = contract.mode === 'single-site' && contract.certificatePolicy === 'preview-bypass'
        ? { previewBypassOrigins: [contract.url], tlsBypassRequestOptions: { rejectUnauthorized: false } }
        : {};
      return (await probeTargetPreflightSet(subjectInputs, {
        preflight,
        preflightOptions: { ...preflightOptions, ...bypassOptions },
      })).identity;
    },
  });
}

function fail(code, message, cause) {
  throw new SharedReleaseCiError(code, message, cause);
}

function positiveInteger(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function validateClient(client) {
  const methods = ['launch', 'readLaunchOperation', 'readRun', 'readPublication', 'reprobeTargetIdentity'];
  if (!record(client) || methods.some((method) => typeof client[method] !== 'function')) {
    throw new TypeError(`Shared release CI client must implement ${methods.join(', ')}.`);
  }
  return client;
}

function validateLaunchIdentity(operation, expected) {
  if (!record(operation) || !OPERATION_ID.test(operation.operationId ?? '')
    || !RUN_ID.test(operation.runId ?? '')
    || operation.runId !== `run-${operation.operationId.slice(0, 32)}`
    || operation.requestId !== expected.requestId
    || operation.requestDigest !== expected.requestDigest
    || !['accepted', 'running', 'completed'].includes(operation.state)) {
    fail('CI_LAUNCH_IDENTITY_MISMATCH', 'Shared launch operation does not match the stable CI request identity.');
  }
  if (expected.operationId !== null
    && (operation.operationId !== expected.operationId || operation.runId !== expected.runId)) {
    fail('CI_LAUNCH_IDENTITY_MISMATCH', 'Shared launch operation identity changed while CI was waiting.');
  }
  if (operation.state === 'completed') {
    if (!record(operation.outcome) || operation.outcome.status !== 'succeeded'
      || (operation.outcome.runId !== undefined && operation.outcome.runId !== operation.runId)) {
      fail('CI_LAUNCH_FAILED', 'Shared launch operation completed without a successful bound run.');
    }
  } else if (operation.outcome !== null && operation.outcome !== undefined) {
    fail('CI_LAUNCH_IDENTITY_MISMATCH', 'Non-terminal shared launch operation exposed a terminal outcome.');
  }
  return operation;
}

async function waitForLaunch(client, initial, expected, { maximumPolls, pollMs, sleep }) {
  let operation = validateLaunchIdentity(initial, expected);
  expected.operationId = operation.operationId;
  expected.runId = operation.runId;
  if (operation.state === 'completed') return operation;
  for (let poll = 0; poll < maximumPolls; poll += 1) {
    operation = validateLaunchIdentity(await client.readLaunchOperation({
      operationId: expected.operationId,
      runId: expected.runId,
    }), expected);
    if (operation.state === 'completed') return operation;
    if (poll + 1 < maximumPolls) await sleep(pollMs);
  }
  fail('CI_LAUNCH_TIMEOUT', 'Shared launch operation did not complete inside the bounded CI wait.');
}

function validateTerminalRun(value, runId) {
  if (!record(value) || value.runId !== runId
    || !Number.isSafeInteger(value.runRevision) || value.runRevision < 1) {
    fail('CI_RUN_INVALID', 'Shared run response does not match the launched run.');
  }
  if (value.compilationState !== 'sealed') {
    return { ready: false, reason: 'compilation' };
  }
  let executionManifest;
  let finalSubject;
  try {
    executionManifest = parseExecutionManifest(value.executionManifest);
    finalSubject = parseFinalReleaseSubject(value.finalSubject);
  } catch (error) {
    fail('CI_RUN_INVALID', 'Sealed shared run contains invalid immutable release contracts.', error);
  }
  if (value.executionManifestDigest !== executionManifest.digest
    || value.finalSubjectDigest !== finalSubject.digest
    || finalSubject.executionManifestDigest !== executionManifest.digest) {
    fail('CI_RUN_INVALID', 'Sealed shared run digest bindings are inconsistent.');
  }
  if (!record(value.workItems) || !record(value.ledgerSequences)
    || !Number.isSafeInteger(value.ledgerSequences.mutation) || value.ledgerSequences.mutation < 0) {
    fail('CI_RUN_INVALID', 'Sealed shared run lacks durable work or mutation-ledger state.');
  }
  const manifestIds = executionManifest.workItems.map(({ id }) => id).sort();
  const storedIds = Object.keys(value.workItems).sort();
  if (canonicalJson(manifestIds) !== canonicalJson(storedIds)) {
    fail('CI_MANIFEST_WORK_MISMATCH', 'Durable work items do not exactly match the sealed execution manifest.');
  }
  const active = Object.values(value.workItems).filter(({ state } = {}) => ACTIVE_WORK_STATES.has(state));
  if (active.length > 0 || Object.values(value.workItems).some(({ state } = {}) => !TERMINAL_WORK_STATES.has(state))) {
    return { ready: false, reason: 'work' };
  }
  return { ready: true, executionManifest, finalSubject };
}

function validatePublication(value, run, terminal) {
  let publication;
  try {
    publication = parsePublicationEnvelope(value);
  } catch (error) {
    fail('CI_PUBLICATION_INVALID', 'Current release publication is not a valid canonical envelope.', error);
  }
  if (run.currentPublicationDigest !== publication.digest) {
    fail('CI_PUBLICATION_STALE', 'Release publication is not the durable current publication head.');
  }
  if (publication.runId !== run.runId
    || publication.finalSubjectDigest !== terminal.finalSubject.digest
    || publication.decision.subjectDigest !== terminal.finalSubject.digest
    || publication.decision.executionManifestDigest !== terminal.executionManifest.digest
    || publication.decision.grantedAuthority !== terminal.finalSubject.grantedAuthority.qualifier
    || canonicalJson(publication.decision.certifiedScope) !== canonicalJson(terminal.finalSubject.grantedAuthority.scope)) {
    fail('CI_PUBLICATION_INVALID', 'Release publication does not match the sealed run subject, authority, or execution set.');
  }
  if (publication.ledgerSequences.observations !== run.ledgerSequences.mutation) {
    fail('CI_PUBLICATION_NOT_CAUGHT_UP', 'Release publication has not caught up to the durable observation ledger.');
  }
  return publication;
}

async function unavailableAsNull(callback) {
  try {
    return await callback();
  } catch (error) {
    if (error?.code === 'PUBLICATION_UNAVAILABLE' || error?.serverCode === 'PUBLICATION_UNAVAILABLE'
      || error?.code === 'CI_PUBLICATION_MISSING') return null;
    throw error;
  }
}

async function confirmCandidate(client, runId, firstRun, firstPublication) {
  const [run, rawPublication] = await Promise.all([
    client.readRun({ runId }),
    unavailableAsNull(() => client.readPublication({ runId })),
  ]);
  if (rawPublication === null) fail('CI_PUBLICATION_CHANGED', 'Current release publication disappeared during confirmation.');
  if (rawPublication?.digest !== firstPublication.digest
    || run?.currentPublicationDigest !== firstRun.currentPublicationDigest
    || run?.currentPublicationDigest !== rawPublication?.digest
    || run?.runRevision !== firstRun.runRevision
    || run?.ledgerSequences?.mutation !== firstRun.ledgerSequences.mutation) {
    fail('CI_PUBLICATION_CHANGED', 'Run state or current publication head changed during confirmation.');
  }
  const terminal = validateTerminalRun(run, runId);
  if (!terminal.ready) fail('CI_PUBLICATION_CHANGED', 'Run left its terminal sealed state during confirmation.');
  return { run, publication: validatePublication(rawPublication, run, terminal), terminal };
}

export async function runSharedReleaseCi({
  client: rawClient,
  requestId,
  intent,
  maximumLaunchPolls = 600,
  maximumPublicationPolls = 3_600,
  pollMs = 1_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const client = validateClient(rawClient);
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)
    || !record(intent) || typeof sleep !== 'function') {
    throw new TypeError('Shared release CI requires a stable requestId, launch intent, client, and sleep function.');
  }
  positiveInteger(maximumLaunchPolls, 'maximumLaunchPolls');
  positiveInteger(maximumPublicationPolls, 'maximumPublicationPolls');
  positiveInteger(pollMs, 'pollMs', 0);
  const expected = {
    requestId,
    requestDigest: canonicalDigest(intent),
    operationId: null,
    runId: null,
  };
  const launch = await waitForLaunch(client, await client.launch({ requestId, intent }), expected, {
    maximumPolls: maximumLaunchPolls, pollMs, sleep,
  });
  let lastReason = 'publication';
  for (let poll = 0; poll < maximumPublicationPolls; poll += 1) {
    const run = await client.readRun({ runId: launch.runId });
    const terminal = validateTerminalRun(run, launch.runId);
    if (!terminal.ready) {
      lastReason = terminal.reason;
    } else if (!run.currentPublicationDigest) {
      lastReason = 'publication';
    } else {
      const rawPublication = await unavailableAsNull(() => client.readPublication({ runId: launch.runId }));
      if (rawPublication === null) {
        lastReason = 'publication';
      } else {
        if ((launch.outcome.subjectCoreDigest !== null && launch.outcome.subjectCoreDigest !== undefined
          && launch.outcome.subjectCoreDigest !== run.subjectCoreDigest)
          || (launch.outcome.executionManifestDigest !== null && launch.outcome.executionManifestDigest !== undefined
            && launch.outcome.executionManifestDigest !== run.executionManifestDigest)) {
          fail('CI_LAUNCH_RUN_MISMATCH', 'Completed shared launch outcome does not match the sealed run contracts.');
        }
        const publication = validatePublication(rawPublication, run, terminal);
        const confirmed = await confirmCandidate(client, launch.runId, run, publication);
        let reprobedIdentity;
        try {
          reprobedIdentity = await client.reprobeTargetIdentity({
            runId: launch.runId,
            targets: terminal.finalSubject.targets,
            expectedIdentity: terminal.finalSubject.deploymentIdentity,
          });
        } catch (error) {
          fail('CI_TARGET_REPROBE_FAILED', 'Target identity reprobe failed.', error);
        }
        if (canonicalJson(reprobedIdentity) !== canonicalJson(terminal.finalSubject.deploymentIdentity)) {
          fail('CI_TARGET_IDENTITY_DRIFT', 'Target deployment identity changed after the audited subject was sealed.');
        }
        return Object.freeze({
          schemaVersion: 1,
          confirmed: true,
          operationId: launch.operationId,
          runId: launch.runId,
          run: Object.freeze(structuredClone(confirmed.run)),
          publication: confirmed.publication,
          assertionExpected: Object.freeze({
            subjectDigest: confirmed.publication.finalSubjectDigest,
            authority: confirmed.publication.decision.grantedAuthority,
            executionSetDigest: confirmed.publication.decision.executionManifestDigest,
            runRevision: confirmed.publication.runRevision,
            decisionRevision: confirmed.publication.decisionRevision,
          }),
        });
      }
    }
    if (poll + 1 < maximumPublicationPolls) await sleep(pollMs);
  }
  if (lastReason === 'compilation') fail('CI_COMPILATION_PENDING', 'Shared run did not seal its inventory-derived execution graph inside the bounded wait.');
  if (lastReason === 'work') fail('CI_WORK_NOT_TERMINAL', 'Shared run retained queued, running, or invalid work inside the bounded wait.');
  fail('CI_PUBLICATION_MISSING', 'Terminal shared run did not publish a current caught-up release envelope inside the bounded wait.');
}
