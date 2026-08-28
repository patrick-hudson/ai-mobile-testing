import { pageAuditDefinition } from './catalog.js';
import { resolveEnvironmentPath } from './environments.js';
import { CANDIDATE_HTML_ROUTES } from './routes.js';
import type { AuditApplicability, AuditDefinition } from './types.js';

export const PAGE_AUDIT_FAMILY = 'candidate-html-routes' as const;
export const PAGE_AUDIT_ENTRY_SPEC = 'tests/page-audit.spec.ts' as const;

export interface PageAuditFamilyMember {
  routePath: string;
  definition: AuditDefinition;
  applicability: Extract<AuditApplicability, 'full-sweep-projects' | 'candidate-full-sweep-projects'>;
}

/**
 * A candidate route can claim production coverage only when the reviewed
 * environment mapping resolves a real production baseline. This function is
 * shared by test declaration and plugin expansion so portal metadata cannot
 * advertise a project that Playwright will immediately skip.
 */
export function pageAuditApplicability(
  candidatePath: string,
): PageAuditFamilyMember['applicability'] {
  return resolveEnvironmentPath('production', candidatePath) === null
    ? 'candidate-full-sweep-projects'
    : 'full-sweep-projects';
}

export function pageAuditFamilyMembers(): PageAuditFamilyMember[] {
  return CANDIDATE_HTML_ROUTES.map(({ path: routePath }) => ({
    routePath,
    definition: pageAuditDefinition(routePath),
    applicability: pageAuditApplicability(routePath),
  }));
}
