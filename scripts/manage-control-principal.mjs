#!/usr/bin/env node
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import { openCredentialOutput } from './lib/credential-file.mjs';

const options = parse(process.argv.slice(2));
const authority = await openScopedCredentialAuthority({ root: required(options, 'root') });
let result;
let credentialOutput = null;
if (['create', 'rotate'].includes(options.action)) credentialOutput = await openCredentialOutput(required(options, 'credential-out'));
try {
if (options.action === 'create') {
  result = await authority.createPrincipal({
    id: required(options, 'id'), kind: required(options, 'kind'),
    roles: list(required(options, 'roles')), projectIds: list(required(options, 'projects')),
    runIds: list(required(options, 'runs')), expiresAt: options['expires-at'] ?? null,
  });
} else if (options.action === 'rotate') result = await authority.rotateCredential(required(options, 'id'));
else if (options.action === 'roles') result = { principal: await authority.setRoles(required(options, 'id'), list(required(options, 'roles'))) };
else if (options.action === 'revoke') result = { principal: await authority.revokePrincipal(required(options, 'id')), revoked: true };
else throw new Error('--action must be create, rotate, roles, or revoke.');
if (result.credential) await credentialOutput.write(result.credential);
await writeStream(process.stdout, `${JSON.stringify({ ...result, credential: undefined, credentialPath: credentialOutput?.path ?? undefined })}\n`);
if (credentialOutput) await writeStream(process.stderr, `Credential written once to ${credentialOutput.path}; the secret was not emitted on stdout.\n`);
} catch (error) {
  await credentialOutput?.abort();
  throw error;
}
function parse(argv) { const value = {}; for (let index = 0; index < argv.length; index += 2) { if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`Invalid option ${argv[index]}.`); value[argv[index].slice(2)] = argv[index + 1]; } return value; }
function required(value, key) { if (!value[key]) throw new Error(`--${key} is required.`); return value[key]; }
function list(value) { return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]; }
function writeStream(stream, value) { return new Promise((resolve, reject) => stream.write(value, (error) => error ? reject(error) : resolve())); }
