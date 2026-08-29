import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const CREDENTIAL_PATTERN = /^amt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}$/;
const PROMOTION_CLAIM_PATTERN = /^amtp\.[a-f0-9]{32}\.[A-Za-z0-9_-]{32,}$/;

export async function readCredentialFile(file, { label = 'credential' } = {}) {
  if (typeof file !== 'string' || !file) throw new Error(`${label} file is required.`);
  const resolved = path.resolve(file);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 40 || metadata.size > 4_096
    || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} file must be a bounded, regular mode-0600 file.`);
  }
  const credential = (await readFile(resolved, 'utf8')).trim();
  if (!CREDENTIAL_PATTERN.test(credential)) throw new Error(`${label} file contains an invalid credential.`);
  return credential;
}

export async function openCredentialOutput(file) {
  if (typeof file !== 'string' || !file) throw new Error('--credential-out is required for create and rotate.');
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (parentMetadata.mode & 0o077) !== 0) {
    throw new Error('Credential output parent must be an existing private directory.');
  }
  const handle = await open(resolved, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  let settled = false;
  return Object.freeze({
    path: resolved,
    async write(credential) {
      if (settled) throw new Error('Credential output has already been settled.');
      if (!CREDENTIAL_PATTERN.test(String(credential))) throw new Error('Refusing to write an invalid credential.');
      try {
        await handle.writeFile(`${credential}\n`, 'utf8');
        await handle.sync();
        await handle.chmod(0o600);
        await handle.close();
        const parentHandle = await open(parent, fsConstants.O_RDONLY);
        try { await parentHandle.sync(); } finally { await parentHandle.close(); }
        settled = true;
      } catch (error) {
        settled = true;
        await handle.close().catch(() => undefined);
        await unlink(resolved).catch(() => undefined);
        throw error;
      }
    },
    async abort() {
      if (settled) return;
      settled = true;
      await handle.close();
      await unlink(resolved).catch(() => undefined);
    },
  });
}

export async function openPromotionClaimOutput(file) {
  if (typeof file !== 'string' || !file) throw new Error('--claim-token-file is required for live release assertion.');
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (parentMetadata.mode & 0o077) !== 0) {
    throw new Error('Promotion claim output parent must be an existing private directory.');
  }
  const handle = await open(resolved, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  let settled = false;
  return Object.freeze({
    path: resolved,
    async write(token) {
      if (settled) throw new Error('Promotion claim output has already been settled.');
      if (!PROMOTION_CLAIM_PATTERN.test(String(token))) throw new Error('Refusing to write an invalid promotion claim.');
      try {
        await handle.writeFile(`${token}\n`, 'utf8');
        await handle.sync();
        await handle.chmod(0o600);
        await handle.close();
        const parentHandle = await open(parent, fsConstants.O_RDONLY);
        try { await parentHandle.sync(); } finally { await parentHandle.close(); }
        settled = true;
      } catch (error) {
        settled = true;
        await handle.close().catch(() => undefined);
        await unlink(resolved).catch(() => undefined);
        throw error;
      }
    },
    async abort() {
      if (settled) return;
      settled = true;
      await handle.close();
      await unlink(resolved).catch(() => undefined);
    },
  });
}
