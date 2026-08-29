export const SHADOW_ACCEPTANCE_CASE_IDS: readonly string[];
export const SHADOW_CORRUPTION_CASE_IDS: readonly string[];
export function buildPreRegisteredShadowMatrix(): {
  cases: unknown[];
  intentionalDifferences: unknown[];
};
