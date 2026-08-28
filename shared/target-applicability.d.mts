export interface AuditApplicabilityTarget {
  id: string;
  environment: string;
  deviceClass: string;
  engine: string;
  fullSweep: boolean;
}

export interface SingleSiteApplicabilityTarget {
  id: string;
  sourceComparativeTargetId: string;
}

export function targetMatchesAuditApplicability(
  applicability: string,
  target: AuditApplicabilityTarget,
): boolean;

export function applicableTargetIds<const Targets extends readonly AuditApplicabilityTarget[]>(
  applicability: string,
  targets: Targets,
): Array<Targets[number]['id']>;

export function singleSiteTargetMatchesAuditApplicability(
  applicability: string,
  target: SingleSiteApplicabilityTarget,
  comparativeTargets: readonly AuditApplicabilityTarget[],
): boolean;

export function applicableSingleSiteTargetIds<const Targets extends readonly SingleSiteApplicabilityTarget[]>(
  applicability: string,
  targets: Targets,
  comparativeTargets: readonly AuditApplicabilityTarget[],
): Array<Targets[number]['id']>;
