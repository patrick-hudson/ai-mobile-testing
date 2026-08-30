#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import { openCredentialOutput, readCredentialFile } from './lib/credential-file.mjs';

const authority = await openScopedCredentialAuthority({ root: required('AUDIT_SHARED_CREDENTIAL_ROOT') });
const projectId = process.env.AUDIT_SHARED_PROJECT_ID ?? 'default';
const ordinaryGrant = {
  capabilities: capabilities(
    process.env.AUDIT_SHARED_ORDINARY_CAPABILITIES
      ?? 'inventory:http,browser:chromium,browser:firefox,browser:webkit',
  ),
  resourceClasses: ['ordinary'],
};
const performanceGrant = { capabilities: ['performance:lighthouse'], resourceClasses: ['performance'] };
const identities = [
  { id: 'compose-worker-ordinary-a', credentialFile: required('AUDIT_SHARED_WORKER_A_CREDENTIAL_FILE'),
    kind: 'worker', roles: ['worker'], runIds: ['*'], grant: ordinaryGrant },
  { id: 'compose-worker-ordinary-b', credentialFile: required('AUDIT_SHARED_WORKER_B_CREDENTIAL_FILE'),
    kind: 'worker', roles: ['worker'], runIds: ['*'], grant: ordinaryGrant },
  { id: 'compose-worker-performance', credentialFile: required('AUDIT_SHARED_PERFORMANCE_CREDENTIAL_FILE'),
    kind: 'worker', roles: ['worker'], runIds: ['*'], grant: performanceGrant },
  { id: process.env.AUDIT_SHARED_PORTAL_OPERATOR_ID ?? 'operator-local-cutover',
    credentialFile: required('AUDIT_SHARED_PORTAL_OPERATOR_CREDENTIAL_FILE'),
    kind: 'human', roles: ['operator'], runIds: ['*'], grant: null },
];

const provisioned = [];
for (const identity of identities) {
  provisioned.push(await ensureIdentity(identity));
}
await writeStream(process.stdout, `${JSON.stringify({ provisioned })}\n`);

async function ensureIdentity({ id, credentialFile, kind, roles, runIds, grant }) {
  const resolved = path.resolve(credentialFile);
  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new Error(`Credential directory for ${id} must be a real directory.`);
  await chmod(parent, 0o700);

  try {
    const current = await readCredentialFile(resolved, { label: `${id} credential` });
    const principal = await authority.authenticateCredential(current);
    if (principal.id !== id || principal.kind !== kind) throw new Error(`Credential file for ${id} belongs to another principal.`);
    if (!identityMatches(principal, { roles, runIds, grant })) {
      await repairIdentity(id, { roles, runIds, grant }, principal);
      return { id, status: 'updated' };
    }
    return { id, status: 'reused' };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  let issued;
  try {
    issued = await authority.createPrincipal({
      id,
      kind,
      roles,
      projectIds: [projectId],
      runIds,
      workerGrant: grant,
    });
  } catch (error) {
    if (error?.code !== 'PRINCIPAL_EXISTS') throw error;
    await repairIdentity(id, { roles, runIds, grant });
    issued = await authority.rotateCredential(id);
  }

  const temporary = `${resolved}.next-${process.pid}`;
  const output = await openCredentialOutput(temporary);
  try {
    await output.write(issued.credential);
    await rename(temporary, resolved);
    const directory = await open(parent, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await output.abort();
    throw error;
  }
  return { id, status: 'issued' };
}

function identityMatches(principal, { roles, runIds, grant }) {
  return isDeepStrictEqual(principal.roles, roles)
    && isDeepStrictEqual(principal.projectIds, [projectId])
    && isDeepStrictEqual(principal.runIds, runIds)
    && isDeepStrictEqual(principal.workerGrant, grant);
}

async function repairIdentity(id, { roles, runIds, grant }, current = null) {
  if (!current || !isDeepStrictEqual(current.roles, roles)) await authority.setRoles(id, roles);
  if (!current || !isDeepStrictEqual(current.projectIds, [projectId])
    || !isDeepStrictEqual(current.runIds, runIds)) {
    await authority.setScopes(id, { projectIds: [projectId], runIds });
  }
  if (grant && (!current || !isDeepStrictEqual(current.workerGrant, grant))) {
    await authority.setWorkerGrant(id, grant);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function capabilities(value) {
  const parsed = [...new Set(String(value).split(',').map((entry) => entry.trim()).filter(Boolean))].sort();
  if (parsed.length === 0 || parsed.length > 32
    || parsed.some((entry) => !/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u.test(entry))) {
    throw new Error('AUDIT_SHARED_ORDINARY_CAPABILITIES must be a bounded comma-separated capability list.');
  }
  return parsed;
}

function writeStream(stream, value) {
  return new Promise((resolve, reject) => stream.write(value, (error) => error ? reject(error) : resolve()));
}
