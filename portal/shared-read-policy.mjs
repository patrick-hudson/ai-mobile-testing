import { CONTROL_ACTIONS, ControlPlaneError } from '../shared/control-plane-contract.mjs';

const SAFE_OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function classifySharedReadRequest({ method, pathname } = {}) {
  if (!['GET', 'HEAD'].includes(String(method ?? '').toUpperCase()) || typeof pathname !== 'string') return null;

  if (pathname === '/api/config' || pathname === '/api/settings/anthropic-key') {
    return policy(CONTROL_ACTIONS.SETTINGS_READ);
  }
  if (pathname === '/api/console/v1' || pathname.startsWith('/api/console/v1/')) {
    return policy(CONTROL_ACTIONS.RUN_LIST, null, true);
  }
  if (pathname === '/api/runs' || pathname === '/api/single-site/runs') {
    return policy(CONTROL_ACTIONS.RUN_LIST, null, true);
  }
  if (pathname === '/api/single-site/visual-baselines'
    || pathname.startsWith('/api/single-site/visual-baselines/')) {
    return policy(CONTROL_ACTIONS.BASELINE_READ, null, true);
  }

  const directArtifact = /^\/(?:single-site-)?artifacts\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
  if (directArtifact) {
    const runId = objectId(directArtifact[1]);
    const requestedPath = decodePath(directArtifact[2] ?? '');
    const archive = requestedPath === 'checklist' || requestedPath.startsWith('checklist/');
    return policy(archive ? CONTROL_ACTIONS.ARCHIVE_READ : CONTROL_ACTIONS.ARTIFACT_READ, runId);
  }

  const runRoute = /^\/api\/(?:single-site\/)?runs\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
  if (!runRoute) return null;
  const runId = objectId(runRoute[1]);
  const suffix = decodePath(runRoute[2] ?? '');
  if (suffix === 'events' || suffix === 'gallery/events') return policy(CONTROL_ACTIONS.STREAM_READ, runId);
  if (suffix === 'logs') return policy(CONTROL_ACTIONS.LOG_READ, runId);
  if (suffix === 'artifacts') return policy(CONTROL_ACTIONS.ARTIFACT_LIST, runId);
  if (suffix === 'manual-evidence' || suffix === 'ai-review/result') return policy(CONTROL_ACTIONS.ARTIFACT_READ, runId);
  if (suffix === 'report' || suffix.startsWith('report/')) return policy(CONTROL_ACTIONS.REPORT_READ, runId);
  if (suffix === 'gallery' || suffix.startsWith('gallery/')) return policy(CONTROL_ACTIONS.GALLERY_READ, runId);
  return policy(CONTROL_ACTIONS.RUN_VIEW, runId);
}

export function assertSharedListScope(principal) {
  if (!Array.isArray(principal?.runIds) || !principal.runIds.includes('*')) {
    throw new ControlPlaneError(
      'AUTHORIZATION_DENIED',
      'Aggregate run reads require project-wide run scope.',
      403,
    );
  }
  return principal;
}

function policy(action, runId = null, aggregate = false) {
  return Object.freeze({ action, runId, aggregate });
}

function objectId(encoded) {
  let value;
  try { value = decodeURIComponent(encoded); } catch {
    throw new ControlPlaneError('READ_OBJECT_INVALID', 'Read object identifier is invalid.', 400);
  }
  if (!SAFE_OBJECT_ID.test(value)) throw new ControlPlaneError('READ_OBJECT_INVALID', 'Read object identifier is invalid.', 400);
  return value;
}

function decodePath(encoded) {
  try { return decodeURIComponent(encoded); } catch {
    throw new ControlPlaneError('READ_OBJECT_INVALID', 'Read object path is invalid.', 400);
  }
}
