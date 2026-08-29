#!/usr/bin/env node
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  initializeCutoverAdmissionGate,
  openCutoverAdmissionGate,
} from './lib/shared-cutover-orchestrator.mjs';
import {
  openParentRunStore,
  readReleaseAuthoritySelector,
} from './lib/parent-run-store.mjs';

const storeRoot = path.resolve(process.argv[2] ?? '/var/lib/ai-mobile-testing/shared/canonical');
const admissionRoot = path.join(storeRoot, 'cutover-admission');
const gateFile = path.join(admissionRoot, 'release-admission-gate.json');
const selectorFile = path.join(storeRoot, 'release-authority-selector.json');

async function exists(file) {
  try { return await lstat(file); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const [gateStat, selectorStat] = await Promise.all([exists(gateFile), exists(selectorFile)]);
if (gateStat) {
  if (!gateStat.isFile() || gateStat.isSymbolicLink()) throw new Error('Existing shared admission gate is not a regular file.');
  await openCutoverAdmissionGate({ root: admissionRoot, verifyStorage: false });
  process.stdout.write('[SHARED_ADMISSION_INIT] Existing durable admission gate verified.\n');
} else {
  if (selectorStat) {
    if (!selectorStat.isFile() || selectorStat.isSymbolicLink()) {
      throw new Error('Existing release-authority selector is not a regular file.');
    }
    const store = await openParentRunStore({ root: storeRoot, verifyStorage: false });
    const selector = await readReleaseAuthoritySelector(store);
    if (selector.phase !== 'SHADOW' || selector.activationEpoch !== 0
      || selector.activationRevision !== null || selector.activatedAt !== null
      || selector.activeWriterProtocol !== null || selector.activeBuildIdentity !== null) {
      throw new Error('Shared admission gate is missing after authority drain or activation; refusing to recreate it OPEN.');
    }
    await initializeCutoverAdmissionGate({ root: admissionRoot, verifyStorage: false });
    process.stdout.write('[SHARED_ADMISSION_INIT] Missing gate migrated OPEN for a verified preactivation SHADOW store.\n');
  } else {
    await initializeCutoverAdmissionGate({ root: admissionRoot, verifyStorage: false });
    process.stdout.write('[SHARED_ADMISSION_INIT] Initial OPEN admission gate created before canonical-store initialization.\n');
  }
}
