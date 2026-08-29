import type { WorkLease } from './parent-run-store.mjs';
import type { WorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';
export function createSharedWorkCommand(lease: WorkLease, evidenceRoot: string, environment?: NodeJS.ProcessEnv): {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  descriptor: WorkExecutionDescriptor;
};
export const sharedWorkExecutorPath: string;
