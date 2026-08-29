export const SHARED_DOCKER_RESILIENCE_ENV: 'AUDIT_SHARED_RESILIENCE_PROOF';
export const SHARED_DOCKER_RESILIENCE_SPEC: 'tests/fixtures/shared-docker-resilience.spec.ts';
export const SHARED_DOCKER_RESILIENCE_TARGET_ID: 'single-site-mobile-chromium';
export const SHARED_DOCKER_RESILIENCE_ORIGIN: 'https://proof.invalid';
export const SHARED_DOCKER_RESILIENCE_EVIDENCE_POLICY: Readonly<{ mode: 'structured-data'; rationale: string }>;
export const SHARED_DOCKER_RESILIENCE_CASES: ReadonlyArray<Readonly<{
  auditId: string;
  caseId: string;
  delayMs: number;
  expectedOutcome: 'completed_pass' | 'completed_product_failure';
}>>;
export const SHARED_DOCKER_RESILIENCE_WORK_ITEM_COUNT: number;
export const SHARED_DOCKER_RESILIENCE_WORKLOAD: Readonly<Record<string, unknown>>;
export const SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST: `sha256:${string}`;
export function validateSharedDockerResilienceBinding(value: string, entrySpec: string): boolean;
