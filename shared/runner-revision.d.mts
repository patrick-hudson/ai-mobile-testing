export function deriveRunnerRevision(
  root: string,
  options?: { prefix?: 'workspace' | 'image' },
): Promise<string>;

export function runnerRevisionDigest(value: unknown): string;

export function resolveRunnerRevision(options: {
  root: string;
  environment?: NodeJS.ProcessEnv;
  embeddedPath?: string;
}): Promise<string>;
