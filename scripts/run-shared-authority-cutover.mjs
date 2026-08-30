#!/usr/bin/env node
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { deriveRunnerRevision } from '../shared/runner-revision.mjs';
import {
  probeTargetPreflightSet,
  targetPreflightInputsForRunContract,
} from '../shared/target-preflight-set.mjs';
import {
  PARENT_RUN_STORE_SCHEMA_VERSION,
  PARENT_RUN_WRITER_PROTOCOL,
  acquireStoreCoordinator,
  openParentRunStore,
  readReleaseAuthoritySelector,
  releaseStoreCoordinator,
} from './lib/parent-run-store.mjs';
import {
  activateSharedAuthorityCutover,
  authorizeSharedBuildHandoffCanaryLaunch,
  authorizeSharedCutoverCanaryLaunch,
  beginSharedAuthorityBuildHandoff,
  completeSharedAuthorityBuildHandoff,
  captureSharedAuthorityDrainObservation,
  initializeCutoverAdmissionGate,
  openCutoverAdmissionGate,
  prepareSharedAuthorityCutover,
  prepareSharedAuthorityBuildHandoff,
  prequalifySharedAuthorityBuild,
  recordSharedBuildHandoffCanary,
  recordSharedCutoverCanary,
  reopenSharedAdmissionAfterCanaries,
  rollbackSharedAuthorityBeforeActivation,
  setSharedPromotionAvailability,
  sharedCutoverConfigurationDigest,
} from './lib/shared-cutover-orchestrator.mjs';
import { createSharedReleaseHttpClient } from './lib/shared-release-ci.mjs';
import { readCredentialFile } from './lib/credential-file.mjs';
import {
  initializeLegacyAuthorityFence,
  openLegacyAuthorityFence,
} from './lib/legacy-authority-fence.mjs';
import { openSharedLaunchOperationStore } from './lib/shared-launch-operation-store.mjs';
import { readTrustedStoreMarker } from './lib/shared-store-runtime.mjs';
import { rehearseSharedStoreBackup } from './lib/shared-store-backup-rehearsal.mjs';
import { openSharedAuthorityFloor } from './lib/shared-authority-floor.mjs';
import { createSharedBuildCompatibilityProof } from './create-shared-build-compatibility-proof.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ACTIONS = new Set([
  'rehearse-backup', 'prepare', 'activate', 'launch-single-site-canary', 'launch-comparative-canary',
  'record-single-site-canary', 'record-comparative-canary', 'reopen',
  'rollback', 'disable-promotion', 'enable-promotion',
  'prequalify-handoff-target', 'prepare-handoff', 'begin-handoff',
  'launch-handoff-single-site-canary', 'launch-handoff-comparative-canary',
  'record-handoff-single-site-canary', 'record-handoff-comparative-canary', 'complete-handoff',
]);

const HANDOFF_ACTIONS = new Set([...ACTIONS].filter((action) => action.includes('handoff')));
const COORDINATOR_ACTIONS = new Set([
  'prepare', 'activate', 'rollback', 'disable-promotion', 'enable-promotion',
  'prequalify-handoff-target', 'prepare-handoff', 'begin-handoff', 'complete-handoff',
]);

export function sharedCutoverActionRequiresCoordinator(action) {
  if (!ACTIONS.has(action)) throw new TypeError(`Unknown shared cutover action: ${action}`);
  return COORDINATOR_ACTIONS.has(action);
}

function usage() {
  return `Usage: run-shared-authority-cutover.mjs <${[...ACTIONS].join('|')}> --config <operator-config.json>`;
}

function parseArguments(argv) {
  if (argv.length !== 3 || !ACTIONS.has(argv[0]) || argv[1] !== '--config' || argv[2].startsWith('-')) {
    throw new TypeError(usage());
  }
  return { action: argv[0], configFile: argv[2] };
}

async function readBoundedJsonFile(file, label, maximumBytes = 4 * 1_048_576) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > maximumBytes) {
      throw new TypeError(`${label} must be a bounded non-empty regular file.`);
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle?.close();
  }
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

async function openConfiguredStore(config, action, marker) {
  const store = requiredObject(config.store, 'config.store');
  const originalGeneration = Number(store.storeGeneration);
  const options = {
    root: store.root,
    deploymentIdentity: store.deploymentIdentity,
    volumeIdentity: store.volumeIdentity,
    volumeDriver: store.volumeDriver ?? 'local',
    storeMarker: marker,
    storeGeneration: originalGeneration,
    expectedStoreGeneration: originalGeneration,
    schemaFloor: store.schemaFloor ?? PARENT_RUN_STORE_SCHEMA_VERSION,
    supportedSchemaVersion: store.supportedSchemaVersion ?? PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: store.writerProtocol ?? PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: store.minimumWriterProtocol ?? PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity: store.buildIdentity,
    prequalifiedRollbackBuilds: store.prequalifiedRollbackBuilds,
    backupMarker: store.backupMarker,
    verifyStorage: store.verifyStorage !== false,
  };
  try {
    return await openParentRunStore(options);
  } catch (error) {
    if (error?.code !== 'STORE_GENERATION_MISMATCH'
      || !['activate', 'launch-single-site-canary', 'launch-comparative-canary', 'record-single-site-canary', 'record-comparative-canary', 'reopen', 'disable-promotion', 'enable-promotion',
        'prequalify-handoff-target', 'prepare-handoff', 'begin-handoff', 'launch-handoff-single-site-canary', 'launch-handoff-comparative-canary',
        'record-handoff-single-site-canary', 'record-handoff-comparative-canary', 'complete-handoff'].includes(action)) throw error;
    return openParentRunStore({ ...options, expectedStoreGeneration: originalGeneration + 1 });
  }
}

function configuredCanary(config, mode, collection = 'canaries') {
  const values = requiredObject(config[collection], `config.${collection}`);
  return requiredObject(values[mode], `config.${collection}.${mode}`);
}

async function readCanaryIntent(config, mode, collection = 'canaries') {
  const canary = configuredCanary(config, mode, collection);
  return {
    canary,
    intent: await readBoundedJsonFile(canary.intentFile, `${mode} canary intent`),
  };
}

async function reprobeCanaryIntent(intent) {
  const contract = requiredObject(intent.runContract, 'canary intent runContract');
  const preflightOptions = contract.mode === 'single-site' && contract.certificatePolicy === 'preview-bypass'
    ? { previewBypassOrigins: [contract.url], tlsBypassRequestOptions: { rejectUnauthorized: false } }
    : {};
  return (await probeTargetPreflightSet(targetPreflightInputsForRunContract(contract), { preflightOptions })).identity;
}

async function canaryReprobeByMode(config, collection = 'canaries') {
  const intents = new Map();
  for (const mode of ['single-site', 'comparative']) {
    intents.set(mode, (await readCanaryIntent(config, mode, collection)).intent);
  }
  return async (state) => {
    const mode = state?.finalSubject?.mode;
    if (!intents.has(mode)) throw new TypeError('Canary evidence mode has no configured trusted target intent.');
    return reprobeCanaryIntent(intents.get(mode));
  };
}

function expectedStoreFromConfig(config, marker) {
  return {
    deploymentIdentity: config.store.deploymentIdentity,
    volumeIdentity: config.store.volumeIdentity,
    storeMarkerDigest: canonicalDigest({ storeMarker: marker }),
    storeGeneration: Number(config.store.storeGeneration),
    schemaVersion: config.store.supportedSchemaVersion ?? PARENT_RUN_STORE_SCHEMA_VERSION,
    schemaFloor: config.store.schemaFloor ?? PARENT_RUN_STORE_SCHEMA_VERSION,
    currentWriterProtocol: config.store.writerProtocol ?? PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: config.store.minimumWriterProtocol ?? PARENT_RUN_WRITER_PROTOCOL,
    backupMarker: config.store.backupMarker,
  };
}

function cutoverIdentityFromConfig(config, expectedStore) {
  return {
    cutoverId: config.cutoverId,
    activationRevision: config.activationRevision,
    buildIdentity: config.store.buildIdentity,
    rollbackBuildIdentity: config.rollbackBuildIdentity,
    expectedStore,
  };
}

export async function beginSharedAuthorityBuildHandoffFromCli({
  store,
  coordinator,
  admissionGate,
  legacyAuthorityFence,
  reportDirectory,
  handoffId,
  targetBuildIdentity,
  launchOperationRoot,
  legacyComparativeRoot,
  legacySingleSiteQueueRoot,
  clock = store?.clock ?? (() => Date.now()),
}) {
  const selector = await readReleaseAuthoritySelector(store);
  const resumablePendingHandoff = selector.phase === 'PROMOTION_DISABLED'
    && selector.handoffId === handoffId
    && selector.pendingBuildIdentity === targetBuildIdentity;
  let drainObservation;
  if (!resumablePendingHandoff) {
    const launchOperationStore = await openSharedLaunchOperationStore({
      root: launchOperationRoot,
      requireExisting: true,
    });
    drainObservation = await captureSharedAuthorityDrainObservation({
      store,
      coordinator,
      admissionGate,
      legacyAuthorityFence,
      launchOperationStore,
      cutoverId: handoffId,
      legacyComparativeRoot,
      legacySingleSiteQueueRoot,
      clock,
    });
  }
  return beginSharedAuthorityBuildHandoff({
    store,
    coordinator,
    admissionGate,
    legacyAuthorityFence,
    reportDirectory,
    handoffId,
    drainObservation,
    clock,
  });
}

export async function runSharedAuthorityCutoverCli(argv, {
  output = process.stdout,
  createCompatibilityProof = createSharedBuildCompatibilityProof,
  resolveWorkspaceRevision = () => deriveRunnerRevision(repositoryRoot),
} = {}) {
  const { action, configFile } = parseArguments(argv);
  const config = requiredObject(await readBoundedJsonFile(configFile, 'Operator config'), 'Operator config');
  if (config.schemaVersion !== 1) throw new TypeError('Operator config must use schemaVersion 1.');
  const marker = await readTrustedStoreMarker(config.store?.storeMarkerFile, 'trusted shared store marker');
  const store = await openConfiguredStore(config, action, marker);
  const expectedStore = expectedStoreFromConfig(config, marker);
  const backupRehearsal = config.backupRehearsal
    ? requiredObject(config.backupRehearsal, 'config.backupRehearsal')
    : null;
  if (action === 'rehearse-backup') {
    if (!backupRehearsal) throw new TypeError('config.backupRehearsal must be an object.');
    const backupMarker = await readTrustedStoreMarker(
      backupRehearsal.backupMarkerFile,
      'trusted shared backup marker',
    );
    if (backupMarker !== expectedStore.backupMarker) {
      throw new TypeError('Trusted backup marker does not match config.store.backupMarker.');
    }
    const receipt = await rehearseSharedStoreBackup({
      rehearsalId: backupRehearsal.rehearsalId ?? `${config.cutoverId}-backup`,
      sourceRoot: store.root,
      backupRoot: backupRehearsal.backupRoot,
      restoreRoot: backupRehearsal.restoreRoot,
      receiptPath: backupRehearsal.receiptFile,
      storeMarker: marker,
      backupMarker,
      buildIdentity: config.store.buildIdentity,
      configurationDigest: sharedCutoverConfigurationDigest(cutoverIdentityFromConfig(config, expectedStore)),
      expectedStore,
      limits: backupRehearsal.limits,
    });
    output.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  const admissionRoot = path.join(store.root, 'cutover-admission');
  if (config.admissionRoot && path.resolve(config.admissionRoot) !== path.resolve(admissionRoot)) {
    throw new TypeError('config.admissionRoot must identify the canonical store cutover-admission directory.');
  }
  let admissionGate;
  try {
    admissionGate = await openCutoverAdmissionGate({ root: admissionRoot });
  } catch (error) {
    if (action !== 'prepare' || error?.code !== 'CUTOVER_ADMISSION_UNAVAILABLE') throw error;
    const selector = await readReleaseAuthoritySelector(store);
    if (selector.phase !== 'SHADOW' || selector.activationEpoch !== 0) throw error;
    admissionGate = await initializeCutoverAdmissionGate({ root: admissionRoot });
  }
  const coordinator = sharedCutoverActionRequiresCoordinator(action)
    ? await acquireStoreCoordinator(store, {
        ownerId: config.coordinatorOwnerId,
        leaseMs: config.coordinatorLeaseMs ?? 30_000,
      })
    : null;
  try {
  const legacyFenceRoot = path.join(store.root, 'legacy-authority');
  if (config.legacyAuthorityFenceRoot
    && path.resolve(config.legacyAuthorityFenceRoot) !== path.resolve(legacyFenceRoot)) {
    throw new TypeError('config.legacyAuthorityFenceRoot must identify the canonical store legacy-authority directory.');
  }
  let legacyAuthorityFence;
  try {
    legacyAuthorityFence = await openLegacyAuthorityFence({ root: legacyFenceRoot });
  } catch (error) {
    if (action !== 'prepare' || error?.code !== 'LEGACY_AUTHORITY_UNAVAILABLE') throw error;
    const selector = await readReleaseAuthoritySelector(store);
    if (selector.phase !== 'SHADOW' || selector.activationEpoch !== 0) throw error;
    legacyAuthorityFence = await initializeLegacyAuthorityFence({ root: legacyFenceRoot });
  }
  const operatorReview = config.operatorReview
    ? requiredObject(config.operatorReview, 'config.operatorReview')
    : null;
  const floorAction = action.includes('handoff') || action === 'activate'
    || action === 'disable-promotion' || action === 'enable-promotion';
  const authorityFloor = floorAction ? await openSharedAuthorityFloor({
    root: config.authorityFloorRoot,
    protectedRoots: [store.root, backupRehearsal?.backupRoot, backupRehearsal?.restoreRoot].filter(Boolean),
    verifyStorage: config.authorityFloorVerifyStorage !== false,
  }) : null;
  let commonInput = null;
  if (action === 'prepare' || action === 'activate') {
    if (!backupRehearsal) throw new TypeError('config.backupRehearsal must be an object.');
    commonInput = {
      cutoverId: config.cutoverId,
      activationRevision: config.activationRevision,
      buildIdentity: config.store.buildIdentity,
      rollbackBuildIdentity: config.rollbackBuildIdentity,
      expectedStore,
      shadowReport: config.shadowReportFile
        ? await readBoundedJsonFile(config.shadowReportFile, 'Shadow validation report', 16 * 1_048_576)
        : null,
      operatorReview: requiredObject(operatorReview, 'config.operatorReview'),
      backupRehearsalReceipt: await readBoundedJsonFile(
        backupRehearsal.receiptFile,
        'Backup rehearsal receipt',
      ),
      backupRoot: backupRehearsal.backupRoot,
      restoreRoot: backupRehearsal.restoreRoot,
    };
  }

  let result;
  const handoff = HANDOFF_ACTIONS.has(action)
    ? requiredObject(config.handoff, 'config.handoff')
    : null;
  if (action === 'prequalify-handoff-target') {
    const resilienceProof = handoff.resilienceProofFile
      ? await readBoundedJsonFile(
          handoff.resilienceProofFile,
          'Authoritative shared Docker resilience proof',
          32 * 1_048_576,
        )
      : null;
    const compatibilityProof = resilienceProof === null ? null : createCompatibilityProof({
      resilienceProof,
      targetBuildIdentity: handoff.targetBuildIdentity,
      expectedWorkspaceRevision: await resolveWorkspaceRevision(),
    });
    result = await prequalifySharedAuthorityBuild({
      store, coordinator, legacyAuthorityFence, authorityFloor,
      reportDirectory: config.reportDirectory,
      prequalificationId: handoff.prequalificationId,
      targetBuildIdentity: handoff.targetBuildIdentity,
      compatibilityProof,
      operatorReview: handoff.operatorReview
        ? requiredObject(handoff.operatorReview, 'config.handoff.operatorReview')
        : null,
    });
  } else if (action === 'prepare-handoff') {
    result = await prepareSharedAuthorityBuildHandoff({
      store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory: config.reportDirectory,
      handoffId: handoff.handoffId,
      targetBuildIdentity: handoff.targetBuildIdentity,
      operatorReview: requiredObject(handoff.operatorReview, 'config.handoff.operatorReview'),
    });
  } else if (action === 'begin-handoff') {
    const legacySources = requiredObject(config.legacySources, 'config.legacySources');
    result = await beginSharedAuthorityBuildHandoffFromCli({
      store, coordinator, admissionGate, legacyAuthorityFence,
      reportDirectory: config.reportDirectory,
      handoffId: handoff.handoffId,
      targetBuildIdentity: handoff.targetBuildIdentity,
      launchOperationRoot: path.join(store.root, 'launch-operations'),
      legacyComparativeRoot: legacySources.comparativeRoot,
      legacySingleSiteQueueRoot: legacySources.singleSiteQueueRoot,
    });
  } else if (action === 'launch-handoff-single-site-canary' || action === 'launch-handoff-comparative-canary') {
    const mode = action.includes('single-site') ? 'single-site' : 'comparative';
    const { canary, intent } = await readCanaryIntent(config, mode, 'handoffCanaries');
    const control = requiredObject(config.control, 'config.control');
    const permit = await authorizeSharedBuildHandoffCanaryLaunch({
      store, admissionGate, reportDirectory: config.reportDirectory,
      handoffId: handoff.handoffId, mode, runId: canary.runId,
      requestId: canary.requestId, actor: canary.actor,
      intent, supersedeReason: canary.supersedeReason ?? null,
    });
    const client = createSharedReleaseHttpClient({
      baseUrl: control.server,
      token: await readCredentialFile(control.credentialFile, { label: 'Handoff control credential' }),
    });
    result = { permit, operation: await client.launch({ requestId: canary.requestId, intent }) };
  } else if (action === 'record-handoff-single-site-canary' || action === 'record-handoff-comparative-canary') {
    const mode = action.includes('single-site') ? 'single-site' : 'comparative';
    const { canary, intent } = await readCanaryIntent(config, mode, 'handoffCanaries');
    result = await recordSharedBuildHandoffCanary({
      store, admissionGate, reportDirectory: config.reportDirectory,
      handoffId: handoff.handoffId, mode, runId: canary.runId,
      probeTargetIdentity: () => reprobeCanaryIntent(intent),
    });
  } else if (action === 'complete-handoff') {
    result = await completeSharedAuthorityBuildHandoff({
      store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory: config.reportDirectory,
      handoffId: handoff.handoffId,
      probeTargetIdentity: await canaryReprobeByMode(config, 'handoffCanaries'),
    });
  } else if (action === 'prepare') {
    result = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, legacyAuthorityFence,
      reportDirectory: config.reportDirectory, input: commonInput,
    });
  } else if (action === 'activate') {
    const legacySources = requiredObject(config.legacySources, 'config.legacySources');
    const launchOperationRoot = path.join(store.root, 'launch-operations');
    if (config.launchOperationRoot
      && path.resolve(config.launchOperationRoot) !== path.resolve(launchOperationRoot)) {
      throw new TypeError('config.launchOperationRoot must identify the canonical store launch-operations directory.');
    }
    const launchOperationStore = await openSharedLaunchOperationStore({
      root: launchOperationRoot, requireExisting: true,
    });
    const drainObservation = await captureSharedAuthorityDrainObservation({
      store,
      coordinator,
      admissionGate,
      legacyAuthorityFence,
      launchOperationStore,
      cutoverId: config.cutoverId,
      legacyComparativeRoot: legacySources.comparativeRoot,
      legacySingleSiteQueueRoot: legacySources.singleSiteQueueRoot,
    });
    result = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory: config.reportDirectory, input: commonInput,
      drainObservation,
    });
  } else if (action === 'launch-single-site-canary' || action === 'launch-comparative-canary') {
    const mode = action === 'launch-single-site-canary' ? 'single-site' : 'comparative';
    const { canary, intent } = await readCanaryIntent(config, mode);
    const control = requiredObject(config.control, 'config.control');
    const permit = await authorizeSharedCutoverCanaryLaunch({
      store,
      admissionGate,
      reportDirectory: config.reportDirectory,
      cutoverId: config.cutoverId,
      mode,
      requestId: canary.requestId,
      actor: canary.actor,
      intent,
      supersedeReason: canary.supersedeReason ?? null,
    });
    const client = createSharedReleaseHttpClient({
      baseUrl: control.server,
      token: await readCredentialFile(control.credentialFile, { label: 'Cutover control credential' }),
    });
    result = { permit, operation: await client.launch({ requestId: canary.requestId, intent }) };
  } else if (action === 'record-single-site-canary' || action === 'record-comparative-canary') {
    const mode = action === 'record-single-site-canary' ? 'single-site' : 'comparative';
    const { canary, intent } = await readCanaryIntent(config, mode);
    result = await recordSharedCutoverCanary({
      store, admissionGate, reportDirectory: config.reportDirectory, cutoverId: config.cutoverId,
      mode, runId: canary.runId,
      probeTargetIdentity: () => reprobeCanaryIntent(intent),
    });
  } else if (action === 'reopen') {
    result = await reopenSharedAdmissionAfterCanaries({
      store, admissionGate, reportDirectory: config.reportDirectory, cutoverId: config.cutoverId,
      probeTargetIdentity: await canaryReprobeByMode(config),
    });
  } else if (action === 'rollback') {
    result = await rollbackSharedAuthorityBeforeActivation({
      store, coordinator, admissionGate, legacyAuthorityFence, reportDirectory: config.reportDirectory,
      cutoverId: config.cutoverId, buildIdentity: config.store.buildIdentity,
      operatorReview: requiredObject(operatorReview, 'config.operatorReview'),
    });
  } else {
    const enable = action === 'enable-promotion';
    const healthCanaries = enable
      ? Object.fromEntries((await Promise.all(['single-site', 'comparative'].map(async (mode) => [
        mode, configuredCanary(config, mode, 'promotionHealth').runId,
      ]))))
      : null;
    result = await setSharedPromotionAvailability({
      store,
      coordinator,
      authorityFloor,
      phase: enable ? 'ACTIVE' : 'PROMOTION_DISABLED',
      buildIdentity: config.store.buildIdentity,
      reportDirectory: config.reportDirectory,
      cutoverId: config.cutoverId,
      healthCanaries,
      probeTargetIdentity: enable ? await canaryReprobeByMode(config, 'promotionHealth') : undefined,
    });
  }
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (coordinator !== null) await releaseStoreCoordinator(store, coordinator);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSharedAuthorityCutoverCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[shared-cutover] ${error?.code ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
