import { canonicalDigest } from './canonical-contract.mjs';

export const SHARED_DOCKER_RESILIENCE_ENV = 'AUDIT_SHARED_RESILIENCE_PROOF';
export const SHARED_DOCKER_RESILIENCE_SPEC = 'tests/fixtures/shared-docker-resilience.spec.ts';
export const SHARED_DOCKER_RESILIENCE_TARGET_ID = 'single-site-mobile-chromium';
export const SHARED_DOCKER_RESILIENCE_ORIGIN = 'https://proof.invalid';
export const SHARED_DOCKER_RESILIENCE_EVIDENCE_POLICY = Object.freeze({
  mode: 'structured-data',
  rationale: 'Retain a frozen structured checkpoint for deterministic shared-worker topology and recovery proof.',
});
export const SHARED_DOCKER_RESILIENCE_CASES = Object.freeze(Array.from({ length: 8 }, (_, index) => {
  const auditId = `U4P-${String(index + 1).padStart(3, '0')}`;
  return Object.freeze({
    auditId,
    caseId: `${auditId}:shared-docker-resilience`,
    delayMs: ['U4P-002', 'U4P-003'].includes(auditId) ? 15_000 : 1_200,
    expectedOutcome: auditId === 'U4P-008' ? 'completed_product_failure' : 'completed_pass',
  });
}));
export const SHARED_DOCKER_RESILIENCE_WORK_ITEM_COUNT = SHARED_DOCKER_RESILIENCE_CASES.length;

export const SHARED_DOCKER_RESILIENCE_WORKLOAD = Object.freeze({
  schemaVersion: 1,
  kind: 'shared-docker-resilience-fixture',
  entrySpec: SHARED_DOCKER_RESILIENCE_SPEC,
  targetId: SHARED_DOCKER_RESILIENCE_TARGET_ID,
  origin: SHARED_DOCKER_RESILIENCE_ORIGIN,
  evidencePolicy: SHARED_DOCKER_RESILIENCE_EVIDENCE_POLICY,
  cases: SHARED_DOCKER_RESILIENCE_CASES,
});
export const SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST = canonicalDigest(SHARED_DOCKER_RESILIENCE_WORKLOAD);

export function validateSharedDockerResilienceBinding(value, entrySpec) {
  if (!['0', '1'].includes(value)) {
    throw new Error(`${SHARED_DOCKER_RESILIENCE_ENV} must be exactly 0 or 1.`);
  }
  const enabled = value === '1';
  if (enabled !== (entrySpec === SHARED_DOCKER_RESILIENCE_SPEC)) {
    throw new Error('The isolated shared Docker resilience flag and proof fixture must be used together.');
  }
  return enabled;
}
