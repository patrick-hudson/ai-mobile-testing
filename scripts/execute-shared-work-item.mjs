import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditCaseTag } from '../shared/audit-case-identity.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { buildLiveRouteInventory } from '../shared/live-route-inventory.mjs';
import { preflightQuitting7ohSite } from '../shared/site-preflight.mjs';
import { sealSharedGenericRouteExecutionPublication } from '../shared/single-site-route-plan.mjs';
import { parseWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import {
  SHARED_DOCKER_RESILIENCE_ENV,
  validateSharedDockerResilienceBinding,
} from '../shared/shared-docker-resilience-contract.mjs';
import { sealWorkItemEvidenceIndex, sealWorkItemEvidenceMember } from '../shared/work-item-evidence-index.mjs';
import { startBrowserEgressProxy } from './lib/browser-egress-proxy.mjs';
import { collectSharedPlaywrightArtifacts } from './lib/shared-playwright-work-item.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_JSON_BYTES = 16 * 1_048_576;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseJson(name, value) {
  try { return JSON.parse(value); } catch (error) { throw new Error(`${name} is invalid JSON: ${error.message}`); }
}

function validateIdentity(value, descriptor) {
  const keys = ['runId', 'workItemId', 'attempt', 'subjectCoreDigest', 'runnerRevision', 'executionDescriptorDigest'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))
    || typeof value.runId !== 'string' || !value.runId
    || value.workItemId !== descriptor.workItemId
    || !Number.isSafeInteger(value.attempt) || value.attempt < 1
    || value.subjectCoreDigest !== descriptor.subjectCoreDigest
    || value.runnerRevision !== descriptor.runnerRevision
    || value.executionDescriptorDigest !== descriptor.digest) {
    throw new Error('Shared result identity does not match the compiler-issued descriptor.');
  }
  return value;
}

function exactEvidenceRoot(value) {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || resolved !== value || value.includes('\0')) throw new Error('Evidence root must be an exact absolute path.');
  return resolved;
}

function logger(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
}

async function boundedJson(file, label) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${label} must be a bounded regular JSON file.`);
  }
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function generatedEvidenceDescriptor(evidenceRoot, pathname, mediaType, logicalName, purpose = 'structured') {
  const bytes = await fs.readFile(path.join(evidenceRoot, ...pathname.split('/')));
  return {
    path: pathname,
    mediaType,
    logicalName,
    purpose,
    sizeBytes: bytes.length,
    contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function safeInheritedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => (
    typeof value === 'string' && !name.startsWith('AUDIT_SHARED_')
  )));
}

function playwrightEnvironment(descriptor, artifactRoot, proxyUrl = null, genericRoutePublication = null) {
  const resilienceProof = process.env[SHARED_DOCKER_RESILIENCE_ENV] ?? '0';
  const proofEnabled = validateSharedDockerResilienceBinding(resilienceProof, descriptor.entrySpec);
  const environment = {
    ...safeInheritedEnvironment(),
    CI: '1',
    AUDIT_RUN_MODE: descriptor.mode,
    AUDIT_RUNNER_REVISION: descriptor.runnerRevision,
    AUDIT_TARGET_IDS: descriptor.targetId,
    AUDIT_ARTIFACT_DIR: artifactRoot,
    AUDIT_PROFILE: 'release',
    AUDIT_WORKERS: '1',
    PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(artifactRoot, 'results.json'),
    ...(proofEnabled ? { [SHARED_DOCKER_RESILIENCE_ENV]: '1' } : {}),
    ...(descriptor.resourceClass === 'performance' ? { AUDIT_EXCLUDE_PERFORMANCE: '0' } : { AUDIT_EXCLUDE_PERFORMANCE: '1' }),
  };
  if (descriptor.mode === 'single-site') {
    Object.assign(environment, {
      AUDIT_SINGLE_SITE_URL: descriptor.origins.candidate,
      AUDIT_SINGLE_SITE_ROLE: descriptor.targetRole,
      AUDIT_SINGLE_SITE_CERTIFICATE_POLICY: descriptor.certificatePolicy,
      AUDIT_SINGLE_SITE_CASE_IDS: JSON.stringify([descriptor.caseId]),
      AUDIT_SINGLE_SITE_EGRESS_PROXY: proxyUrl,
      ...(genericRoutePublication === null ? {} : {
        AUDIT_SINGLE_SITE_ROUTE_INVENTORY: genericRoutePublication.path,
        AUDIT_SINGLE_SITE_GENERIC_TARGET_ID: descriptor.targetId,
        AUDIT_SHARED_EXECUTION_DESCRIPTOR_DIGEST: descriptor.digest,
        AUDIT_SHARED_GENERIC_ROUTE_PUBLICATION_DIGEST: genericRoutePublication.digest,
      }),
    });
  } else {
    Object.assign(environment, {
      CANDIDATE_URL: descriptor.origins.candidate,
      PRODUCTION_URL: descriptor.origins.production,
      CANDIDATE_IGNORE_HTTPS_ERRORS: descriptor.certificatePolicy === 'preview-bypass' ? '1' : '0',
    });
  }
  return environment;
}

async function spawnPlaywright(descriptor, artifactRoot, signal) {
  const executable = path.join(repositoryRoot, 'node_modules', '.bin', 'playwright');
  const args = [
    'test', descriptor.entrySpec,
    `--project=${descriptor.targetId}`,
    `--grep=${auditCaseTag(descriptor.caseId)}`,
    '--workers=1', '--retries=0', '--reporter=json',
  ];
  let egressProxy = null;
  let genericRoutePublication = null;
  let genericRoutePublicationArtifact = null;
  try {
    if (descriptor.mode === 'single-site') {
      egressProxy = await startBrowserEgressProxy({ logger: { emit: (event, detail) => logger(event, detail) } });
    }
    if (descriptor.route !== null) {
      const relative = 'playwright/compiler-input/generic-route-publication.json';
      const publicationPath = path.join(path.dirname(artifactRoot), ...relative.split('/'));
      const publication = sealSharedGenericRouteExecutionPublication(descriptor);
      await fs.mkdir(path.dirname(publicationPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(publicationPath, `${JSON.stringify(publication)}\n`, { flag: 'wx', mode: 0o600 });
      genericRoutePublication = { path: publicationPath, digest: publication.publicationDigest };
      genericRoutePublicationArtifact = { path: relative, mediaType: 'application/json' };
    }
    logger('fixed-command-started', { command: ['playwright', ...args], capability: descriptor.capability });
    const completion = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: repositoryRoot,
        env: playwrightEnvironment(descriptor, artifactRoot, egressProxy?.url ?? null, genericRoutePublication),
        shell: false,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      const terminate = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', terminate, { once: true });
      child.once('error', reject);
      child.once('close', (code, closeSignal) => {
        signal?.removeEventListener('abort', terminate);
        resolve({ code, signal: closeSignal });
      });
    });
    logger('fixed-command-finished', completion);
    if (completion.signal !== null || ![0, 1].includes(completion.code)) {
      throw new Error(`Playwright terminated operationally with code ${completion.code} and signal ${completion.signal}.`);
    }
    const resultsPath = path.join(artifactRoot, 'results.json');
    const document = await boundedJson(resultsPath, 'Playwright results');
    const validated = await collectSharedPlaywrightArtifacts({
      document,
      descriptor,
      artifactRoot,
      evidenceRoot: path.dirname(artifactRoot),
    });
    if ((completion.code === 0) !== (validated.outcome === 'completed_pass')) {
      throw new Error('Playwright exit status disagrees with the exact structured work-item rows.');
    }
    const rowsPath = path.join(artifactRoot, 'work-item-rows.json');
    await fs.writeFile(rowsPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'shared-work-item-rows',
      workItemId: descriptor.workItemId,
      executionDescriptorDigest: descriptor.digest,
      rows: validated.rows,
    })}\n`, { mode: 0o600 });
    const evidenceRoot = path.dirname(artifactRoot);
    const members = [
      ...(genericRoutePublicationArtifact === null ? [] : [await generatedEvidenceDescriptor(
        evidenceRoot, genericRoutePublicationArtifact.path, genericRoutePublicationArtifact.mediaType,
        'compiler-issued-generic-route-publication',
      )]),
      await generatedEvidenceDescriptor(evidenceRoot, 'playwright/work-item-rows.json', 'application/json', 'work-item-rows'),
      ...validated.artifacts,
    ];
    const evidenceIndex = sealWorkItemEvidenceIndex({
      workItemId: descriptor.workItemId,
      executionDescriptorDigest: descriptor.digest,
      row: {
        caseId: descriptor.caseId,
        definitionId: descriptor.definitionId,
        entrySpec: descriptor.entrySpec,
        targetId: descriptor.targetId,
        status: validated.rows[0].status,
        evidencePolicy: validated.rows[0].evidencePolicy,
      },
      members: members.map((member) => ({
        logicalName: member.logicalName,
        purpose: member.purpose,
        mediaType: member.mediaType,
        sizeBytes: member.sizeBytes,
        contentDigest: member.contentDigest,
        transportPath: member.path,
      })),
    });
    const indexPath = path.join(artifactRoot, 'work-item-evidence-index.json');
    await fs.writeFile(indexPath, `${JSON.stringify(evidenceIndex)}\n`, { flag: 'wx', mode: 0o600 });
    const indexedMembers = evidenceIndex.members.map((member) => ({
      path: member.transportPath,
      mediaType: member.mediaType,
      logicalName: member.logicalName,
      purpose: member.purpose,
      sizeBytes: member.sizeBytes,
      contentDigest: member.contentDigest,
      memberDigest: member.memberDigest,
    }));
    const indexArtifact = await generatedEvidenceDescriptor(
      evidenceRoot, 'playwright/work-item-evidence-index.json', 'application/json', 'work-item-evidence-index',
    );
    const sealedIndexMember = sealWorkItemEvidenceMember({
      workItemId: descriptor.workItemId,
      executionDescriptorDigest: descriptor.digest,
      ordinal: members.length + 1,
      logicalName: indexArtifact.logicalName,
      purpose: indexArtifact.purpose,
      mediaType: indexArtifact.mediaType,
      sizeBytes: indexArtifact.sizeBytes,
      contentDigest: indexArtifact.contentDigest,
      transportPath: indexArtifact.path,
    });
    return {
      outcome: validated.outcome,
      reason: validated.outcome === 'completed_pass' ? null : 'playwright-product-failure',
      artifacts: [...indexedMembers, {
        ...indexArtifact,
        memberDigest: sealedIndexMember.memberDigest,
      }],
    };
  } finally {
    await egressProxy?.close();
  }
}

async function executeInventory(descriptor, artifactRoot) {
  logger('inventory-started', { origin: descriptor.origins.candidate, certificatePolicy: descriptor.certificatePolicy });
  const bypass = descriptor.certificatePolicy === 'preview-bypass';
  const outbound = {
    previewBypassOrigins: bypass ? [descriptor.origins.candidate] : [],
    ...(bypass ? { tlsBypassRequestOptions: { rejectUnauthorized: false } } : {}),
  };
  const preflight = await preflightQuitting7ohSite({
    url: descriptor.origins.candidate,
    deploymentRole: descriptor.targetRole,
    certificatePolicy: descriptor.certificatePolicy,
  }, outbound);
  const diagnostic = await buildLiveRouteInventory({
    origin: descriptor.origins.candidate,
    catalogRoutes: ['/'],
    outbound: {
      deploymentRole: descriptor.targetRole,
      certificatePolicy: descriptor.certificatePolicy,
      ...outbound,
      timeoutMs: 10_000,
      maxBodyBytes: 2 * 1_048_576,
      maxRedirects: 4,
    },
  });
  const deploymentIdentityRecheck = preflight.accepted && preflight.preflightDigest ? {
    kind: 'target-preflight-set',
    value: canonicalDigest([{
      origin: preflight.origin,
      role: preflight.deploymentRole,
      identityFingerprint: preflight.identityFingerprint,
      deploymentRevision: preflight.deploymentRevision.fingerprint,
      preflightDigest: preflight.preflightDigest,
    }]),
  } : null;
  const inventoryResult = {
    schemaVersion: 1,
    kind: 'shared-single-site-inventory-result',
    workItemId: descriptor.workItemId,
    executionDescriptorDigest: descriptor.digest,
    deploymentIdentityRecheck,
    preflight,
    diagnostic,
  };
  const file = path.join(artifactRoot, 'live-route-inventory.json');
  await fs.writeFile(file, `${JSON.stringify(inventoryResult)}\n`, { mode: 0o600 });
  const included = diagnostic.inventory?.routes?.filter(({ disposition }) => disposition === 'included').length ?? 0;
  logger('inventory-finished', { includedRoutes: included, failures: diagnostic.failures.length, limitations: diagnostic.limitations.length });
  return {
    outcome: preflight.accepted && deploymentIdentityRecheck && included > 0 ? 'completed_pass' : 'completed_product_failure',
    reason: !preflight.accepted ? 'inventory-preflight-rejected' : (included > 0 ? null : 'inventory-empty'),
    artifacts: [{ path: 'inventory/live-route-inventory.json', mediaType: 'application/json' }],
  };
}

export async function executeSharedWorkItem({ descriptor, identity, evidenceRoot, signal } = {}) {
  descriptor = parseWorkExecutionDescriptor(descriptor);
  identity = validateIdentity(identity, descriptor);
  evidenceRoot = exactEvidenceRoot(evidenceRoot);
  await fs.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const artifactDirectory = descriptor.operation === 'inventory' ? 'inventory' : 'playwright';
  const artifactRoot = path.join(evidenceRoot, artifactDirectory);
  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const result = descriptor.operation === 'inventory'
    ? await executeInventory(descriptor, artifactRoot)
    : await spawnPlaywright(descriptor, artifactRoot, signal);
  const manifest = {
    schemaVersion: 1,
    kind: 'shared-worker-result',
    ...identity,
    outcome: result.outcome,
    reason: result.reason,
    artifacts: result.artifacts,
  };
  await fs.writeFile(path.join(evidenceRoot, 'result.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return manifest;
}

async function main() {
  const descriptor = parseJson('AUDIT_SHARED_EXECUTION_DESCRIPTOR', required('AUDIT_SHARED_EXECUTION_DESCRIPTOR'));
  const identity = parseJson('AUDIT_SHARED_RESULT_IDENTITY', required('AUDIT_SHARED_RESULT_IDENTITY'));
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(`Executor received ${signal}.`)));
  const result = await executeSharedWorkItem({
    descriptor,
    identity,
    evidenceRoot: required('AUDIT_SHARED_EVIDENCE_DIR'),
    signal: abort.signal,
  });
  process.exitCode = result.outcome === 'completed_pass' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
