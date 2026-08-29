import { ControlPlaneError } from '../shared/control-plane-contract.mjs';

const RETIRED_MUTATIONS = Object.freeze([
  ['POST', /^\/api\/runs$/u, 'comparative-launch'],
  ['POST', /^\/api\/single-site\/runs$/u, 'single-site-launch'],
  ['POST', /^\/api\/runs\/[^/]+\/stop$/u, 'comparative-cancel'],
  ['POST', /^\/api\/single-site\/runs\/[^/]+\/cancel$/u, 'single-site-cancel'],
  ['DELETE', /^\/api\/runs\/[^/]+$/u, 'comparative-purge'],
  ['DELETE', /^\/api\/single-site\/runs\/[^/]+$/u, 'single-site-purge'],
  ['POST', /^\/api\/runs\/[^/]+\/manual-evidence$/u, 'manual-evidence'],
  ['POST', /^\/api\/runs\/[^/]+\/manual-uploads$/u, 'manual-upload'],
  ['POST', /^\/api\/runs\/[^/]+\/gallery\/flags$/u, 'comparative-review-flag'],
  ['POST', /^\/api\/runs\/[^/]+\/gallery\/flags\/[^/]+\/transitions$/u, 'comparative-review-transition'],
  ['POST', /^\/api\/single-site\/runs\/[^/]+\/gallery\/items\/[^/]+\/review$/u, 'single-site-visual-review'],
]);

export function classifyRetiredLegacyMutation({ method, pathname } = {}) {
  const normalizedMethod = String(method ?? '').toUpperCase();
  if (typeof pathname !== 'string') return null;
  return RETIRED_MUTATIONS.find(([candidateMethod, pattern]) => (
    candidateMethod === normalizedMethod && pattern.test(pathname)
  ))?.[2] ?? null;
}

export function rejectRetiredLegacyMutation(request) {
  const legacyCapability = classifyRetiredLegacyMutation(request);
  if (!legacyCapability) return null;
  throw new ControlPlaneError(
    'SHARED_LEGACY_MUTATION_RETIRED',
    `Legacy ${legacyCapability} mutation is retired while shared control is enabled; use /api/control/v1.`,
    410,
  );
}
