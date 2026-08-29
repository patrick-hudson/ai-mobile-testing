import type { CanonicalExecutionGraph } from './execution-graph-compiler.mjs';
import type { ReleaseSubjectCore } from './release-subject.mjs';
import type { AuditRunContract } from './run-contract.mjs';
import type { CompileRiskInputs } from './risk-source-observation.mjs';
import type { WorkExecutionDescriptor } from './work-execution-descriptor.mjs';

export interface ScheduledLaunchWorkItem {
  id: string;
  maxAttempts: number;
  capability: string;
  resourceClass: 'ordinary' | 'performance';
  targetId: string;
  specAffinity: string | null;
  executionDescriptor: WorkExecutionDescriptor;
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
    sealedCompileRiskInputs: CompileRiskInputs;
    inventoryBarrier: unknown | null;
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
export function scheduleCanonicalWorkItems(input: {
  executionGraph: CanonicalExecutionGraph;
  subjectCore: ReleaseSubjectCore;
  runnerRevision: string;
}): ScheduledLaunchWorkItem[];
