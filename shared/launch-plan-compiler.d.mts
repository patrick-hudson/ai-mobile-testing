import type { CanonicalExecutionGraph } from './execution-graph-compiler.mjs';
import type { ReleaseSubjectCore } from './release-subject.mjs';
import type { AuditRunContract } from './run-contract.mjs';

export interface ScheduledLaunchWorkItem {
  id: string;
  maxAttempts: number;
  capability: string;
  resourceClass: 'ordinary' | 'performance';
  targetId: string;
  specAffinity: string | null;
}

export interface SharedLaunchPlan {
  schemaVersion: 1;
  kind: 'shared-launch-plan';
  intentDigest: string;
  state: 'pending-inventory' | 'sealed';
  subjectCore: ReleaseSubjectCore;
  inventoryBarrier: unknown | null;
  executionGraph: CanonicalExecutionGraph | null;
  createParentRunInput: {
    subjectCore: ReleaseSubjectCore;
    subjectCoreDigest: string;
    executionManifest?: CanonicalExecutionGraph['executionManifest'];
    executionManifestDigest?: string;
    finalSubject?: CanonicalExecutionGraph['finalSubject'];
    finalSubjectDigest?: string;
    compilationState: 'pending' | 'sealed';
    runnerRevision: string;
    workItems: ScheduledLaunchWorkItem[];
  };
  digest: string;
}

export function compileSharedLaunchPlan(input: {
  intent: { schemaVersion: 1; runContract: AuditRunContract };
  pluginRegistry: unknown;
  targetRegistry: unknown;
  runnerRevision: string;
  configurationRevision: string;
  environmentRevision: string;
  deploymentIdentity: { kind: string; value: string };
}): SharedLaunchPlan;
