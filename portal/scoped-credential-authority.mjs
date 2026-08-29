import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ControlPlaneError } from '../shared/control-plane-contract.mjs';
import { atomicWriteJson, withDirectoryLock } from '../scripts/lib/atomic-filesystem.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/;
const KINDS = new Set(['human', 'service', 'worker']);
const WORKER_RESOURCE_CLASSES = new Set(['ordinary', 'performance']);
const KIND_ROLES = Object.freeze({
  human: new Set(['viewer', 'operator', 'reviewer', 'custodian', 'administrator']),
  service: new Set(['viewer', 'operator', 'custodian', 'delivery']),
  worker: new Set(['worker']),
});

function fail(code, message, statusCode = 400) { throw new ControlPlaneError(code, message, statusCode); }
function nowIso(authority) { return new Date(authority.clock()).toISOString(); }
function unique(values, label, allowed = null) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || !value)) {
    fail('CREDENTIAL_SCHEMA_INVALID', `${label} must be a non-empty string array.`);
  }
  const result = [...new Set(values)].sort();
  if (allowed && result.some((value) => !allowed.has(value))) fail('CREDENTIAL_SCHEMA_INVALID', `${label} contains an unsupported value.`);
  return result;
}
function canonicalTime(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validateScope(values, label) {
  const scoped = unique(values, label);
  if (scoped.some((value) => value !== '*' && !SAFE_ID.test(value))) fail('CREDENTIAL_SCHEMA_INVALID', `${label} contains an invalid scope id.`);
  return scoped;
}
function workerGrant(value, kind, { stored = false } = {}) {
  const invalid = (message) => fail(stored ? 'CREDENTIAL_STORE_CORRUPT' : 'CREDENTIAL_SCHEMA_INVALID', message, stored ? 500 : 400);
  if (kind !== 'worker') {
    if (value !== undefined && value !== null) invalid('Only worker principals may carry a worker grant.');
    return null;
  }
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['capabilities', 'resourceClasses'].includes(key))
    || !('capabilities' in value) || !('resourceClasses' in value)) {
    invalid('Worker grant must contain capabilities and exactly one resource class.');
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > 32
    || value.capabilities.some((capability) => typeof capability !== 'string' || !CAPABILITY.test(capability))) {
    invalid('Worker grant capabilities must be a bounded non-empty capability array.');
  }
  if (!Array.isArray(value.resourceClasses) || value.resourceClasses.length !== 1
    || !WORKER_RESOURCE_CLASSES.has(value.resourceClasses[0])) invalid('Worker grant must contain exactly one valid resource class.');
  return Object.freeze({
    capabilities: Object.freeze([...new Set(value.capabilities)].sort()),
    resourceClasses: Object.freeze([...value.resourceClasses]),
  });
}
function derive(secret, salt) { return scryptSync(secret, Buffer.from(salt, 'base64url'), 32).toString('base64url'); }
function constantMatch(value, expected) {
  const left = Buffer.from(String(value)); const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}
async function atomicJson(authority, file, value) {
  await atomicWriteJson(authority.storage, file, value, { mode: 0o600 });
}
function publicPrincipal(record) {
  return Object.freeze({
    id: record.id, kind: record.kind, roles: [...record.roles], projectIds: [...record.projectIds],
    runIds: [...record.runIds], authVersion: record.authVersion,
    workerGrant: record.workerGrant,
  });
}

export async function openScopedCredentialAuthority({ root, clock = () => Date.now() } = {}) {
  if (!root) fail('CREDENTIAL_SCHEMA_INVALID', 'Credential authority root is required.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('CREDENTIAL_SCHEMA_INVALID', 'Credential authority root must be a real directory.');
  await fs.chmod(root, 0o700);
  const authority = {
    root: path.resolve(root), clock, mutation: Promise.resolve(),
    storage: { root: path.resolve(root), fs, nonce: () => randomBytes(12).toString('hex') },
  };
  await Promise.all(['principals', 'sessions'].map(async (name) => {
    const directory = path.join(authority.root, name);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CREDENTIAL_SCHEMA_INVALID', `${name} credential storage must be a real directory.`);
  }));
  return Object.freeze({
    createPrincipal: (input) => serialize(authority, () => createPrincipal(authority, input)),
    authenticateCredential: (credential) => authenticateCredential(authority, credential),
    revokePrincipal: (id) => serialize(authority, () => mutatePrincipal(authority, id, (record) => ({ ...record, revokedAt: nowIso(authority), authVersion: record.authVersion + 1 }))),
    setRoles: (id, roles) => serialize(authority, () => mutatePrincipal(authority, id, (record) => ({
      ...record, roles: unique(roles, 'roles', KIND_ROLES[record.kind]), authVersion: record.authVersion + 1,
    }))),
    setWorkerGrant: (id, grant) => serialize(authority, () => mutatePrincipal(authority, id, (record) => ({
      ...record, workerGrant: workerGrant(grant, record.kind), authVersion: record.authVersion + 1,
    }))),
    rotateCredential: (id) => serialize(authority, () => rotateCredential(authority, id)),
    createBrowserSession: (principal, options) => serialize(authority, () => createBrowserSession(authority, principal, options)),
    authenticateBrowserSession: (token, options) => serialize(authority, () => authenticateBrowserSession(authority, token, options)),
    logoutBrowserSession: (token) => serialize(authority, () => logoutBrowserSession(authority, token)),
  });
}

function serialize(authority, callback) {
  const locked = () => withDirectoryLock(authority.storage, path.join(authority.root, '.authority.lock'), callback);
  const next = authority.mutation.then(locked, locked);
  authority.mutation = next.catch(() => undefined);
  return next;
}

async function createPrincipal(authority, input) {
  if (!SAFE_ID.test(input?.id) || !KINDS.has(input?.kind)) fail('CREDENTIAL_SCHEMA_INVALID', 'Principal id or kind is invalid.');
  const file = path.join(authority.root, 'principals', `${input.id}.json`);
  if (await fs.stat(file).catch(() => null)) fail('PRINCIPAL_EXISTS', 'Principal already exists.', 409);
  const secret = randomBytes(32).toString('base64url');
  const salt = randomBytes(16).toString('base64url');
  if (input.expiresAt !== undefined && input.expiresAt !== null
    && (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))
      || new Date(input.expiresAt).toISOString() !== input.expiresAt || Date.parse(input.expiresAt) <= authority.clock())) {
    fail('CREDENTIAL_SCHEMA_INVALID', 'expiresAt must be a canonical future timestamp.');
  }
  const body = {
    schemaVersion: 1, id: input.id, kind: input.kind,
    roles: unique(input.roles, 'roles', KIND_ROLES[input.kind]),
    projectIds: validateScope(input.projectIds, 'projectIds'),
    runIds: validateScope(input.runIds, 'runIds'),
    workerGrant: workerGrant(input.workerGrant, input.kind),
    salt, verifier: derive(secret, salt), authVersion: 1, createdAt: nowIso(authority),
    expiresAt: input.expiresAt ?? null, revokedAt: null,
  };
  await atomicJson(authority, file, body);
  return { principal: publicPrincipal(body), credential: `amt.${Buffer.from(input.id).toString('base64url')}.${secret}` };
}

async function readPrincipal(authority, id) {
  if (!SAFE_ID.test(id)) fail('INVALID_CREDENTIAL', 'Credential is invalid.', 401);
  let value;
  try { value = JSON.parse(await fs.readFile(path.join(authority.root, 'principals', `${id}.json`), 'utf8')); } catch {
    fail('INVALID_CREDENTIAL', 'Credential is invalid.', 401);
  }
  if (value?.schemaVersion !== 1 || value.id !== id || !KINDS.has(value.kind)
    || !Array.isArray(value.roles) || value.roles.length < 1 || value.roles.some((role) => !KIND_ROLES[value.kind].has(role))
    || !Array.isArray(value.projectIds) || value.projectIds.length < 1 || value.projectIds.some((scope) => scope !== '*' && !SAFE_ID.test(scope))
    || !Array.isArray(value.runIds) || value.runIds.length < 1 || value.runIds.some((scope) => scope !== '*' && !SAFE_ID.test(scope))
    || typeof value.salt !== 'string' || !/^[A-Za-z0-9_-]{20,}$/u.test(value.salt)
    || typeof value.verifier !== 'string' || !/^[A-Za-z0-9_-]{40,}$/u.test(value.verifier)
    || !Number.isSafeInteger(value.authVersion) || value.authVersion < 1
    || !canonicalTime(value.createdAt) || !canonicalTime(value.expiresAt, { nullable: true })
    || !canonicalTime(value.revokedAt, { nullable: true })) {
    fail('CREDENTIAL_STORE_CORRUPT', 'Credential principal record is corrupt.', 500);
  }
  return { ...value, workerGrant: workerGrant(value.workerGrant, value.kind, { stored: true }) };
}

async function authenticateCredential(authority, credential) {
  const match = /^amt\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{32,})$/.exec(String(credential));
  if (!match) fail('INVALID_CREDENTIAL', 'Credential is invalid.', 401);
  let id;
  try { id = Buffer.from(match[1], 'base64url').toString('utf8'); } catch { fail('INVALID_CREDENTIAL', 'Credential is invalid.', 401); }
  const record = await readPrincipal(authority, id);
  if (!constantMatch(derive(match[2], record.salt), record.verifier)) fail('INVALID_CREDENTIAL', 'Credential is invalid.', 401);
  assertActive(authority, record);
  return publicPrincipal(record);
}

function assertActive(authority, record) {
  if (record.revokedAt) fail('CREDENTIAL_REVOKED', 'Credential has been revoked.', 401);
  if (record.expiresAt && Date.parse(record.expiresAt) <= authority.clock()) fail('CREDENTIAL_EXPIRED', 'Credential has expired.', 401);
}

async function mutatePrincipal(authority, id, transform) {
  const current = await readPrincipal(authority, id);
  const next = transform(current);
  await atomicJson(authority, path.join(authority.root, 'principals', `${id}.json`), next);
  return publicPrincipal(next);
}

async function rotateCredential(authority, id) {
  const current = await readPrincipal(authority, id);
  assertActive(authority, current);
  const secret = randomBytes(32).toString('base64url');
  const salt = randomBytes(16).toString('base64url');
  const next = { ...current, salt, verifier: derive(secret, salt), authVersion: current.authVersion + 1 };
  await atomicJson(authority, path.join(authority.root, 'principals', `${id}.json`), next);
  return { principal: publicPrincipal(next), credential: `amt.${Buffer.from(id).toString('base64url')}.${secret}` };
}

async function createBrowserSession(authority, principal, { idleMs = 30 * 60_000, absoluteMs = 8 * 60 * 60_000 } = {}) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 4 * 60 * 60_000
    || !Number.isSafeInteger(absoluteMs) || absoluteMs < idleMs || absoluteMs > 24 * 60 * 60_000) {
    fail('SESSION_SCHEMA_INVALID', 'Session expiry bounds are invalid.');
  }
  const current = await readPrincipal(authority, principal?.id);
  assertActive(authority, current);
  if (current.kind !== 'human' || current.authVersion !== principal.authVersion) fail('AUTHENTICATION_REQUIRED', 'Only a current human principal may start a browser session.', 401);
  const id = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const salt = randomBytes(16).toString('base64url');
  const created = authority.clock();
  const session = {
    schemaVersion: 1, id, principalId: current.id, principalAuthVersion: current.authVersion,
    salt, verifier: derive(secret, salt), csrfToken: randomBytes(32).toString('base64url'),
    createdAt: new Date(created).toISOString(), lastSeenAt: new Date(created).toISOString(),
    idleExpiresAt: new Date(created + idleMs).toISOString(), absoluteExpiresAt: new Date(created + absoluteMs).toISOString(),
    idleMs, loggedOutAt: null,
  };
  await atomicJson(authority, path.join(authority.root, 'sessions', `${id}.json`), session);
  return { token: `amts.${id}.${secret}`, csrfToken: session.csrfToken, idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt };
}

async function authenticateBrowserSession(authority, token, { renew = true } = {}) {
  const match = /^amts\.([a-f0-9]{32})\.([A-Za-z0-9_-]{32,})$/.exec(String(token));
  if (!match) fail('INVALID_SESSION', 'Browser session is invalid.', 401);
  const file = path.join(authority.root, 'sessions', `${match[1]}.json`);
  let session;
  try { session = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('INVALID_SESSION', 'Browser session is invalid.', 401); }
  if (session?.schemaVersion !== 1 || session.id !== match[1] || !SAFE_ID.test(session.principalId)
    || !Number.isSafeInteger(session.principalAuthVersion) || session.principalAuthVersion < 1
    || typeof session.salt !== 'string' || !/^[A-Za-z0-9_-]{20,}$/u.test(session.salt)
    || typeof session.verifier !== 'string' || !/^[A-Za-z0-9_-]{40,}$/u.test(session.verifier)
    || typeof session.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{40,}$/u.test(session.csrfToken)
    || !canonicalTime(session.createdAt) || !canonicalTime(session.lastSeenAt)
    || !canonicalTime(session.idleExpiresAt) || !canonicalTime(session.absoluteExpiresAt)
    || !canonicalTime(session.loggedOutAt, { nullable: true })
    || !Number.isSafeInteger(session.idleMs) || session.idleMs < 1 || session.idleMs > 4 * 60 * 60_000
    || Date.parse(session.lastSeenAt) < Date.parse(session.createdAt)
    || Date.parse(session.idleExpiresAt) < Date.parse(session.lastSeenAt)
    || Date.parse(session.absoluteExpiresAt) < Date.parse(session.idleExpiresAt)) {
    fail('SESSION_STORE_CORRUPT', 'Browser session record is corrupt.', 500);
  }
  if (!constantMatch(derive(match[2], session.salt), session.verifier)) fail('INVALID_SESSION', 'Browser session is invalid.', 401);
  if (session.loggedOutAt) fail('SESSION_REVOKED', 'Browser session has ended.', 401);
  if (Date.parse(session.idleExpiresAt) <= authority.clock() || Date.parse(session.absoluteExpiresAt) <= authority.clock()) {
    fail('SESSION_EXPIRED', 'Browser session has expired.', 401);
  }
  const principal = await readPrincipal(authority, session.principalId);
  if (principal.revokedAt || principal.authVersion !== session.principalAuthVersion) fail('SESSION_REVOKED', 'Browser session is no longer authorized.', 401);
  assertActive(authority, principal);
  if (renew) {
    const idleExpires = Math.min(authority.clock() + session.idleMs, Date.parse(session.absoluteExpiresAt));
    session.lastSeenAt = nowIso(authority);
    session.idleExpiresAt = new Date(idleExpires).toISOString();
    await atomicJson(authority, file, session);
  }
  return { principal: publicPrincipal(principal), csrfToken: session.csrfToken, idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt };
}

async function logoutBrowserSession(authority, token) {
  const match = /^amts\.([a-f0-9]{32})\./.exec(String(token));
  if (!match) fail('INVALID_SESSION', 'Browser session is invalid.', 401);
  await authenticateBrowserSession(authority, token, { renew: false });
  const file = path.join(authority.root, 'sessions', `${match[1]}.json`);
  const session = JSON.parse(await fs.readFile(file, 'utf8'));
  session.loggedOutAt = nowIso(authority);
  await atomicJson(authority, file, session);
  return true;
}
