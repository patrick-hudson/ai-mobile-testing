export interface AuditApplicabilityTarget {
  id: string;
  environment: string;
  deviceClass: string;
  engine: string;
  fullSweep: boolean;
}

export function targetMatchesAuditApplicability(
  applicability: string,
  target: AuditApplicabilityTarget,
): boolean;

export function applicableTargetIds<const Targets extends readonly AuditApplicabilityTarget[]>(
  applicability: string,
  targets: Targets,
): Array<Targets[number]['id']>;
