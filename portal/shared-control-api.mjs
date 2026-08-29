import { assertPrincipalAuthorized, CONTROL_ACTIONS, ControlPlaneError, validateMutationRequest } from '../shared/control-plane-contract.mjs';
import { createReleaseAssertionResult } from '../shared/control-client-contract.mjs';
import { consumePromotionClaim, issuePromotionClaim } from '../scripts/lib/promotion-claim-store.mjs';
import { parseRunContract } from '../shared/run-contract.mjs';

export const SHARED_CONTROL_API_PREFIX = '/api/control/v1';

export function createSharedRequestAuthorizer({ authority } = {}) {
  if (!authority) throw new TypeError('Shared request authorizer requires a credential authority.');
  return Object.freeze({
    authenticate: (request, options = {}) => authenticate(authority, request, options),
    async authorize(request, action, object = {}, options = {}) {
      const authentication = await authenticate(authority, request, options);
      assertPrincipalAuthorized(authentication.principal, action, object);
      return authentication;
    },
  });
}

export function createSharedControlApi({
  authority, service, claimStore, expectedOrigin, launch = null, readLaunchOperation = null,
  requestAuthorizer = createSharedRequestAuthorizer({ authority }),
  sessionCookiePath = SHARED_CONTROL_API_PREFIX,
} = {}) {
  if (!authority || !service || !claimStore || !expectedOrigin) throw new TypeError('Shared control API dependencies are required.');
  if (!/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]*)$/u.test(sessionCookiePath)) throw new TypeError('Shared session cookie path is invalid.');
  return Object.freeze({
    async handle(request) {
      const url = new URL(request.url, expectedOrigin);
      if (!url.pathname.startsWith(`${SHARED_CONTROL_API_PREFIX}/`) && url.pathname !== SHARED_CONTROL_API_PREFIX) return unhandled();
      try {
        if (request.method === 'POST' && url.pathname === `${SHARED_CONTROL_API_PREFIX}/session`) {
          assertSessionBootstrap(request, expectedOrigin);
          const body = recordBody(request.body);
          const principal = await authority.authenticateCredential(requireString(body.credential, 'credential'));
          const session = await authority.createBrowserSession(principal, {});
          const secure = new URL(expectedOrigin).protocol === 'https:' ? '; Secure' : '';
          return response(200, { schemaVersion: 1, data: { csrfToken: session.csrfToken, idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt } }, {
            'set-cookie': `audit_session=${session.token}; HttpOnly; SameSite=Strict; Path=${sessionCookiePath}${secure}`,
          });
        }
        const authentication = await requestAuthorizer.authenticate(request);
        const principal = authentication.principal;
        if (request.method === 'GET' && url.pathname === `${SHARED_CONTROL_API_PREFIX}/session`) {
          return ok({ principal, csrfToken: authentication.csrfToken, idleExpiresAt: authentication.idleExpiresAt, absoluteExpiresAt: authentication.absoluteExpiresAt });
        }
        if (request.method === 'DELETE' && url.pathname === `${SHARED_CONTROL_API_PREFIX}/session`) {
          mutation(request, authentication, expectedOrigin);
          const token = sessionToken(request);
          await authority.logoutBrowserSession(token);
          return response(200, { schemaVersion: 1, data: { loggedOut: true } }, {
            'set-cookie': `audit_session=; HttpOnly; SameSite=Strict; Path=${sessionCookiePath}; Max-Age=0${new URL(expectedOrigin).protocol === 'https:' ? '; Secure' : ''}`,
          });
        }
        const runMatch = new RegExp(`^${SHARED_CONTROL_API_PREFIX}/runs/([A-Za-z0-9._-]{1,128})(?:/(.*))?$`).exec(url.pathname);
        if (request.method === 'POST' && url.pathname === `${SHARED_CONTROL_API_PREFIX}/runs`) {
          mutation(request, authentication, expectedOrigin);
          const intent = parseLaunchIntent(recordBody(request.body));
          assertPrincipalAuthorized(principal, CONTROL_ACTIONS.RUN_LAUNCH, { projectId: service.projectId });
          if (typeof launch !== 'function') throw new ControlPlaneError('LAUNCH_UNAVAILABLE', 'Shared launch is unavailable.', 503);
          const operation = await launch(principal, {
            requestId: requireIdempotencyKey(request),
            intent,
          });
          const statusUrl = `${SHARED_CONTROL_API_PREFIX}/launch-operations/${operation.operationId}`;
          return accepted({ ...launchOperationView(operation), statusUrl }, { location: statusUrl });
        }
        const launchOperationMatch = new RegExp(`^${SHARED_CONTROL_API_PREFIX}/launch-operations/([a-f0-9]{64})$`).exec(url.pathname);
        if (request.method === 'GET' && launchOperationMatch) {
          if (typeof readLaunchOperation !== 'function') {
            throw new ControlPlaneError('LAUNCH_UNAVAILABLE', 'Shared launch operation reads are unavailable.', 503);
          }
          return ok(launchOperationView(await readLaunchOperation(principal, launchOperationMatch[1])));
        }
        if (!runMatch) return error('CONTROL_ROUTE_NOT_FOUND', 'Control route was not found.', 404);
        const [, runId, suffix = ''] = runMatch;
        if (request.method === 'GET' && suffix === '') return ok(await service.readRun(principal, runId));
        if (request.method === 'GET' && suffix === 'publication') return ok(await service.readPublication(principal, runId));
        if (request.method === 'GET' && suffix === 'executions') return ok(await service.readExecutions(principal, runId));
        if (request.method === 'GET' && suffix === 'logs') return ok(await service.readLogs(principal, runId, { limit: numberQuery(url, 'limit', 200) }));
        if (request.method === 'GET' && suffix === 'operations') return ok(await service.readOperation(principal, runId, {
          kind: url.searchParams.get('kind'), requestId: url.searchParams.get('requestId'),
        }));
        const operationMatch = /^operations\/([a-f0-9]{64})$/u.exec(suffix);
        if (request.method === 'GET' && operationMatch) {
          return ok(await service.readOperationById(principal, runId, operationMatch[1]));
        }
        if (request.method === 'POST' && suffix === 'release/assert') {
          mutation(request, authentication, expectedOrigin);
          const body = recordBody(request.body);
          if (!body.expected || typeof body.expected !== 'object' || Array.isArray(body.expected)) throw new ControlPlaneError('CONTROL_BODY_INVALID', 'expected is required.', 400);
          if (body.expected.projectId !== service.projectId) throw new ControlPlaneError('PROMOTION_SCOPE_MISMATCH', 'Promotion project does not match this control service.', 409);
          const { publication, claim } = await service.withReleaseAssertionFence(principal, runId,
            async (current, authorityContext) => ({
              publication: current,
              claim: await issuePromotionClaim(claimStore, {
                principal, publication: current, authorityContext,
                expected: { ...body.expected, projectId: service.projectId }, ttlMs: body.ttlMs,
                requestId: request.headers['idempotency-key'] ?? body.requestId,
              }),
            }));
          return ok({
            ...claim,
            result: createReleaseAssertionResult(publication, { projectId: service.projectId }),
          });
        }
        if (request.method === 'POST' && suffix === 'promotion/consume') {
          mutation(request, authentication, expectedOrigin);
          const body = recordBody(request.body);
          return ok(await consumePromotionClaim(claimStore, requireString(body.token, 'token'), {
            principal, expectedSubjectDigest: requireString(body.expectedSubjectDigest, 'expectedSubjectDigest'),
            withCurrentPublication: (callback) => service.withPublicationFence(principal, runId, callback),
          }));
        }
        const kind = mutationKind(suffix);
        if (request.method === 'POST' && kind) {
          mutation(request, authentication, expectedOrigin);
          const body = recordBody(request.body);
          const operation = await service.acceptMutation(principal, runId, {
            kind, requestId: request.headers['idempotency-key'] ?? body.requestId,
            expectedRunRevision: body.expectedRunRevision, body,
          });
          const statusUrl = `${SHARED_CONTROL_API_PREFIX}/runs/${encodeURIComponent(runId)}/operations/${operation.operationId}`;
          return accepted({ ...operation, statusUrl }, { location: statusUrl });
        }
        return error('CONTROL_ROUTE_NOT_FOUND', 'Control route was not found.', 404);
      } catch (caught) {
        return error(caught?.code ?? 'CONTROL_REQUEST_FAILED', caught?.message ?? 'Control request failed.', caught?.statusCode ?? 500);
      }
    },
  });
}

async function authenticate(authority, request, { renew = true } = {}) {
  const authorization = String(request.headers?.authorization ?? '');
  if (authorization.startsWith('Bearer ')) return { principal: await authority.authenticateCredential(authorization.slice(7)), browser: false, csrfToken: null };
  const session = String(request.headers?.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('audit_session='))?.slice(14);
  if (!session) throw new ControlPlaneError('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401);
  const authenticated = await authority.authenticateBrowserSession(session, { renew });
  return { ...authenticated, browser: true };
}
function mutation(request, auth, expectedOrigin) {
  validateMutationRequest(request, { expectedOrigin, csrfToken: auth.csrfToken, browser: auth.browser });
}
function assertSessionBootstrap(request, expectedOrigin) {
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  if (headers.origin !== expectedOrigin || headers['sec-fetch-site'] !== 'same-origin'
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers['content-type'] ?? '')) {
    throw new ControlPlaneError('MUTATION_REQUEST_REJECTED', 'Session bootstrap requires same-origin JSON.', 403);
  }
  recordBody(request.body);
}
function recordBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControlPlaneError('CONTROL_BODY_INVALID', 'A JSON object body is required.', 400);
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) throw new ControlPlaneError('CONTROL_BODY_TOO_LARGE', 'Request body exceeds the control bound.', 413);
  return value;
}
function requireString(value, label) {
  if (typeof value !== 'string' || !value || value.length > 4_096) throw new ControlPlaneError('CONTROL_BODY_INVALID', `${label} is invalid.`, 400);
  return value;
}
function requireIdempotencyKey(request) {
  const value = request.headers?.['idempotency-key'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(value)) {
    throw new ControlPlaneError('IDEMPOTENCY_KEY_INVALID', 'Launch requires a 16-128 character Idempotency-Key header.', 400);
  }
  return value;
}
function parseLaunchIntent(value) {
  if (Object.keys(value).length !== 2 || value.schemaVersion !== 1 || !('runContract' in value)) {
    throw new ControlPlaneError(
      'LAUNCH_INTENT_INVALID',
      'Launch accepts only schemaVersion and runContract; run IDs, subjects, work items, projects, and actors are server-derived.',
      400,
    );
  }
  try {
    return Object.freeze({ schemaVersion: 1, runContract: parseRunContract(value.runContract) });
  } catch (error) {
    throw new ControlPlaneError('LAUNCH_INTENT_INVALID', error instanceof Error ? error.message : String(error), 400);
  }
}
function launchOperationView(operation) {
  const { intent, compiledPlan, ...safe } = operation;
  return Object.freeze({
    ...safe,
    mode: intent.runContract.mode,
    requestedAuthority: intent.runContract.scope.qualifier,
    planState: compiledPlan.state,
  });
}
function sessionToken(request) {
  return String(request.headers?.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('audit_session='))?.slice(14) ?? '';
}
function mutationKind(suffix) {
  return ({ cancel: 'cancel', rekick: 'rekick', 'risks/acknowledge': 'risk-acknowledge', 'risks/resolve': 'risk-resolve', 'visual/disposition': 'visual-disposition', purge: 'purge' })[suffix] ?? null;
}
function numberQuery(url, name, fallback) { const value = Number(url.searchParams.get(name) ?? fallback); return value; }
function response(status, body, extraHeaders = {}) { return Object.freeze({ handled: true, status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders }, body }); }
function ok(body) { return response(200, { schemaVersion: 1, data: body }); }
function accepted(body, headers = {}) { return response(202, { schemaVersion: 1, data: body }, headers); }
function error(code, message, status) { return response(status, { schemaVersion: 1, error: { code, message } }); }
function unhandled() { return Object.freeze({ handled: false, status: 0, headers: {}, body: null }); }
