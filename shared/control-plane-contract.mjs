import { timingSafeEqual } from 'node:crypto';

export const CONTROL_ACTIONS = Object.freeze({
  RUN_VIEW: 'run:view',
  RUN_LAUNCH: 'run:launch',
  RUN_CANCEL: 'run:cancel',
  RUN_REKICK: 'run:rekick',
  RISK_ACKNOWLEDGE: 'risk:acknowledge',
  RISK_RESOLVE: 'risk:resolve',
  VISUAL_DISPOSITION: 'visual:disposition',
  RUN_PURGE: 'run:purge',
  RELEASE_ASSERT: 'release:assert',
  PROMOTION_CONSUME: 'promotion:consume',
  WORK_CLAIM: 'work:claim',
  WORK_PUBLISH: 'work:publish',
});

export const CONTROL_ROLES = Object.freeze({
  viewer: [CONTROL_ACTIONS.RUN_VIEW],
  operator: [
    CONTROL_ACTIONS.RUN_VIEW, CONTROL_ACTIONS.RUN_LAUNCH, CONTROL_ACTIONS.RUN_CANCEL,
    CONTROL_ACTIONS.RUN_REKICK,
  ],
  reviewer: [
    CONTROL_ACTIONS.RUN_VIEW, CONTROL_ACTIONS.RISK_ACKNOWLEDGE,
    CONTROL_ACTIONS.RISK_RESOLVE, CONTROL_ACTIONS.VISUAL_DISPOSITION,
  ],
  custodian: [CONTROL_ACTIONS.RUN_VIEW, CONTROL_ACTIONS.RUN_PURGE],
  delivery: [CONTROL_ACTIONS.RUN_VIEW, CONTROL_ACTIONS.RELEASE_ASSERT, CONTROL_ACTIONS.PROMOTION_CONSUME],
  worker: [CONTROL_ACTIONS.WORK_CLAIM, CONTROL_ACTIONS.WORK_PUBLISH],
  administrator: Object.values(CONTROL_ACTIONS).filter((action) => ![
    CONTROL_ACTIONS.WORK_CLAIM, CONTROL_ACTIONS.WORK_PUBLISH,
    CONTROL_ACTIONS.RELEASE_ASSERT, CONTROL_ACTIONS.PROMOTION_CONSUME,
  ].includes(action)),
});

const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost']);
const ACTION_KINDS = new Map([
  [CONTROL_ACTIONS.WORK_CLAIM, new Set(['worker'])],
  [CONTROL_ACTIONS.WORK_PUBLISH, new Set(['worker'])],
  [CONTROL_ACTIONS.RISK_ACKNOWLEDGE, new Set(['human'])],
  [CONTROL_ACTIONS.RISK_RESOLVE, new Set(['human'])],
  [CONTROL_ACTIONS.VISUAL_DISPOSITION, new Set(['human'])],
  [CONTROL_ACTIONS.RELEASE_ASSERT, new Set(['service'])],
  [CONTROL_ACTIONS.PROMOTION_CONSUME, new Set(['service'])],
]);

export class ControlPlaneError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new ControlPlaneError(code, message, statusCode);
}

export function validateMutationDeployment({ bindHost, acceptedSocketHost = bindHost, publishedOrigin, sessionSecure }) {
  let origin;
  try { origin = new URL(publishedOrigin); } catch {
    fail('INSECURE_MUTATION_DEPLOYMENT', 'Mutation service requires an exact published HTTP(S) origin.', 503);
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== publishedOrigin) {
    fail('INSECURE_MUTATION_DEPLOYMENT', 'Mutation service requires an exact published HTTP(S) origin.', 503);
  }
  const local = LOOPBACKS.has(String(bindHost).replace(/^\[|\]$/g, '').toLowerCase())
    && LOOPBACKS.has(String(acceptedSocketHost).replace(/^\[|\]$/g, '').toLowerCase())
    && LOOPBACKS.has(origin.hostname.replace(/^\[|\]$/g, '').toLowerCase());
  if (!local && (origin.protocol !== 'https:' || sessionSecure !== true)) {
    fail('INSECURE_MUTATION_DEPLOYMENT', 'Shared mutation mode requires HTTPS and Secure host-only sessions.', 503);
  }
  if (local && origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    fail('INSECURE_MUTATION_DEPLOYMENT', 'Loopback mutation mode requires HTTP(S).', 503);
  }
  return Object.freeze({ local, publishedOrigin: origin.origin, sessionSecure: local ? sessionSecure === true : true });
}

export function principalActions(principal) {
  if (!principal || !Array.isArray(principal.roles)) fail('AUTHENTICATION_REQUIRED', 'A valid principal is required.', 401);
  return new Set(principal.roles.flatMap((role) => CONTROL_ROLES[role] ?? []));
}

export function assertPrincipalAuthorized(principal, action, object = {}) {
  if (!Object.values(CONTROL_ACTIONS).includes(action)) fail('AUTHORIZATION_DENIED', 'Unknown control action.', 403);
  if (!principalActions(principal).has(action)) fail('AUTHORIZATION_DENIED', 'Principal is not authorized for this action.', 403);
  const allowedKinds = ACTION_KINDS.get(action);
  if (allowedKinds && !allowedKinds.has(principal.kind)) fail('AUTHORIZATION_DENIED', 'Principal kind is not authorized for this action.', 403);
  for (const [field, value] of [['projectIds', object.projectId], ['runIds', object.runId]]) {
    if (!value) continue;
    const allowed = principal[field];
    if (!Array.isArray(allowed) || (!allowed.includes('*') && !allowed.includes(value))) {
      fail('AUTHORIZATION_DENIED', `Principal is not authorized for this ${field === 'runIds' ? 'run' : 'project'}.`, 403);
    }
  }
  return principal;
}

export function validateMutationRequest(request, { expectedOrigin, csrfToken = null, browser = false }) {
  const method = String(request?.method ?? '').toUpperCase();
  const headers = Object.fromEntries(Object.entries(request?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    fail('MUTATION_REQUEST_REJECTED', 'Mutation requires an unsafe HTTP method.', 405);
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers['content-type'] ?? '')) {
    fail('MUTATION_REQUEST_REJECTED', 'Mutation requires application/json.', 415);
  }
  if (browser) {
    if (headers.origin !== expectedOrigin || headers['sec-fetch-site'] !== 'same-origin'
      || typeof csrfToken !== 'string' || !constantMatch(headers['x-audit-csrf'], csrfToken)) {
      fail('MUTATION_REQUEST_REJECTED', 'Browser mutation failed Origin, fetch-metadata, or CSRF validation.', 403);
    }
  } else if (headers.origin && headers.origin !== expectedOrigin) {
    fail('MUTATION_REQUEST_REJECTED', 'Service mutation supplied a conflicting Origin.', 403);
  }
  return true;
}

function constantMatch(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
