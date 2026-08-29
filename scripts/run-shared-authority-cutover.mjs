#!/usr/bin/env node
import { constants as fsConstants, promises as fs } from 'node:fs';

import { canonicalDigest } from '../shared/canonical-contract.mjs';
import {
  PARENT_RUN_STORE_SCHEMA_VERSION,
  PARENT_RUN_WRITER_PROTOCOL,
  acquireStoreCoordinator,
  openParentRunStore,
} from './lib/parent-run-store.mjs';
import {
  activateSharedAuthorityCutover,
  openCutoverAdmissionGate,
  prepareSharedAuthorityCutover,
  rollbackSharedAuthorityBeforeActivation,
  setSharedPromotionAvailability,
} from './lib/shared-cutover-orchestrator.mjs';
import { readTrustedStoreMarker } from './lib/shared-store-runtime.mjs';

const ACTIONS = new Set(['prepare', 'activate', 'rollback', 'disable-promotion', 'enable-promotion']);

function usage() {
  return 'Usage: run-shared-authority-cutover.mjs <prepare|activate|rollback|disable-promotion|enable-promotion> --config <operator-config.json>';
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
      || !['activate', 'disable-promotion', 'enable-promotion'].includes(action)) throw error;
    return openParentRunStore({ ...options, expectedStoreGeneration: originalGeneration + 1 });
  }
}

async function main() {
  const { action, configFile } = parseArguments(process.argv.slice(2));
  const config = requiredObject(await readBoundedJsonFile(configFile, 'Operator config'), 'Operator config');
  if (config.schemaVersion !== 1) throw new TypeError('Operator config must use schemaVersion 1.');
  const marker = await readTrustedStoreMarker(config.store?.storeMarkerFile, 'trusted shared store marker');
  const store = await openConfiguredStore(config, action, marker);
  const admissionGate = await openCutoverAdmissionGate({ root: config.admissionRoot });
  const coordinator = await acquireStoreCoordinator(store, {
    ownerId: config.coordinatorOwnerId,
    leaseMs: config.coordinatorLeaseMs ?? 30_000,
  });
  const operatorReview = requiredObject(config.operatorReview, 'config.operatorReview');
  const commonInput = {
    cutoverId: config.cutoverId,
    activationRevision: config.activationRevision,
    buildIdentity: config.store.buildIdentity,
    rollbackBuildIdentity: config.rollbackBuildIdentity,
    expectedStore: {
      deploymentIdentity: config.store.deploymentIdentity,
      volumeIdentity: config.store.volumeIdentity,
      storeMarkerDigest: canonicalDigest({ storeMarker: marker }),
      storeGeneration: Number(config.store.storeGeneration),
      schemaVersion: config.store.supportedSchemaVersion ?? PARENT_RUN_STORE_SCHEMA_VERSION,
      schemaFloor: config.store.schemaFloor ?? PARENT_RUN_STORE_SCHEMA_VERSION,
      currentWriterProtocol: config.store.writerProtocol ?? PARENT_RUN_WRITER_PROTOCOL,
      minimumWriterProtocol: config.store.minimumWriterProtocol ?? PARENT_RUN_WRITER_PROTOCOL,
      backupMarker: config.store.backupMarker,
    },
    shadowReport: config.shadowReportFile
      ? await readBoundedJsonFile(config.shadowReportFile, 'Shadow validation report', 16 * 1_048_576)
      : null,
    operatorReview,
  };

  let result;
  if (action === 'prepare') {
    result = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: config.reportDirectory, input: commonInput,
    });
  } else if (action === 'activate') {
    result = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: config.reportDirectory, input: commonInput,
      drainObservation: await readBoundedJsonFile(config.drainObservationFile, 'Drain observation'),
    });
  } else if (action === 'rollback') {
    result = await rollbackSharedAuthorityBeforeActivation({
      store, coordinator, admissionGate, reportDirectory: config.reportDirectory,
      cutoverId: config.cutoverId, buildIdentity: config.store.buildIdentity, operatorReview,
    });
  } else {
    result = await setSharedPromotionAvailability({
      store,
      coordinator,
      phase: action === 'disable-promotion' ? 'PROMOTION_DISABLED' : 'ACTIVE',
      buildIdentity: config.store.buildIdentity,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[shared-cutover] ${error?.code ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
