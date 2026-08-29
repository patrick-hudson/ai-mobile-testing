import { canonicalDigest, canonicalJson } from '../../shared/canonical-contract.mjs';
import { parseExecutionManifest } from '../../shared/execution-contract.mjs';
import { parsePublicationEnvelope } from '../../shared/publication-envelope.mjs';
import { parseFinalReleaseSubject } from '../../shared/release-subject.mjs';

const TERMINAL_WORK_STATES = new Set([
  'completed_pass', 'completed_product_failure', 'cancelled', 'incomplete',
]);
const ACTIVE_WORK_STATES = new Set(['queued', 'running']);
const OPERATION_ID = /^[a-f0-9]{64}$/u;
const RUN_ID = /^run-[a-f0-9]{32}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

export class SharedReleaseCiError extends Error {
  constructor(code, message, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SharedReleaseCiError';
    this.code = code;
  }
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
    if (error?.code === 'PUBLICATION_UNAVAILABLE' || error?.code === 'CI_PUBLICATION_MISSING') return null;
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
