#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import { openCredentialOutput, readCredentialFile } from './lib/credential-file.mjs';

const authority = await openScopedCredentialAuthority({ root: required('AUDIT_SHARED_CREDENTIAL_ROOT') });
const projectId = process.env.AUDIT_SHARED_PROJECT_ID ?? 'default';
const identities = [
  ['compose-worker-ordinary-a', required('AUDIT_SHARED_WORKER_A_CREDENTIAL_FILE')],
  ['compose-worker-ordinary-b', required('AUDIT_SHARED_WORKER_B_CREDENTIAL_FILE')],
  ['compose-worker-performance', required('AUDIT_SHARED_PERFORMANCE_CREDENTIAL_FILE')],
];

const provisioned = [];
for (const [id, credentialFile] of identities) {
  provisioned.push(await ensureIdentity({ id, credentialFile }));
}
await writeStream(process.stdout, `${JSON.stringify({ provisioned })}\n`);

async function ensureIdentity({ id, credentialFile }) {
  const resolved = path.resolve(credentialFile);
  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new Error(`Credential directory for ${id} must be a real directory.`);
  await chmod(parent, 0o700);

  try {
    const current = await readCredentialFile(resolved, { label: `${id} credential` });
    const principal = await authority.authenticateCredential(current);
    if (principal.id !== id || principal.kind !== 'worker') throw new Error(`Credential file for ${id} belongs to another principal.`);
    return { id, status: 'reused' };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  let issued;
  try {
    issued = await authority.createPrincipal({
      id,
      kind: 'worker',
      roles: ['worker'],
      projectIds: [projectId],
      runIds: ['*'],
    });
  } catch (error) {
    if (error?.code !== 'PRINCIPAL_EXISTS') throw error;
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

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeStream(stream, value) {
  return new Promise((resolve, reject) => stream.write(value, (error) => error ? reject(error) : resolve()));
}
