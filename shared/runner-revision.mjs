import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const RUNNER_SOURCE_ROOTS = Object.freeze([
  'audit',
  'fixtures',
  'plugins',
  'reporters',
  'scripts',
  'shared',
  'tests',
]);

const RUNNER_ROOT_FILES = Object.freeze([
  'Dockerfile',
  'package.json',
  'package-lock.json',
  'playwright.config.ts',
  'docker/entrypoint.sh',
  'docker/firefox-with-ca.sh',
  'docker/firefox-policies.json',
]);

const REVISION_PATTERN = /^(?:workspace|image):sha256:[a-f0-9]{64}$/;

function assertRunnerRevision(value, label = 'Runner revision') {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw new Error(`${label} must be a workspace or image SHA-256 revision.`);
  }
  return value;
}

export function runnerRevisionDigest(value) {
  const revision = assertRunnerRevision(value);
  return revision.slice(revision.indexOf(':') + 1);
}

async function sourceFiles(root) {
  const files = [...RUNNER_ROOT_FILES];
  for (const sourceRoot of RUNNER_SOURCE_ROOTS) {
    const base = path.join(root, sourceRoot);
    const entries = await fs.readdir(base, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
      files.push(path.relative(root, absolute));
    }
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

export async function deriveRunnerRevision(root, { prefix = 'workspace' } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !['workspace', 'image'].includes(prefix)) {
    throw new TypeError('Runner revision requires an absolute repository root and workspace or image prefix.');
  }
  const hash = createHash('sha256');
  hash.update('ai-mobile-testing-runner-revision-v2\0');
  for (const file of await sourceFiles(root)) {
    hash.update(`${file}\0`);
    hash.update(await fs.readFile(path.join(root, file)));
    hash.update('\0');
  }
  return `${prefix}:sha256:${hash.digest('hex')}`;
}

export async function resolveRunnerRevision({ root, environment = process.env, embeddedPath = '/work/.audit-runner-revision' }) {
  const explicit = environment.AUDIT_RUNNER_REVISION?.trim();
  if (explicit) {
    return assertRunnerRevision(explicit, 'AUDIT_RUNNER_REVISION');
  }
  try {
    const embedded = (await fs.readFile(embeddedPath, 'utf8')).trim();
    return assertRunnerRevision(embedded, 'Embedded runner revision');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return deriveRunnerRevision(root);
}
