import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXECUTOR = path.join(repositoryRoot, 'scripts', 'execute-shared-work-item.mjs');
const PASSTHROUGH_ENVIRONMENT = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ',
  'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH', 'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'AUDIT_MSEDGE_AVAILABLE', 'AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST',
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'SHARED_WORK_DESCRIPTOR_INVALID';
  throw error;
}

export function createSharedWorkCommand(lease, evidenceRoot, environment = process.env) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease) || typeof evidenceRoot !== 'string' || !path.isAbsolute(evidenceRoot)) {
    fail('A work lease and absolute evidence root are required.');
  }
  if (lease.executionDescriptor === null || lease.executionDescriptor === undefined) {
    fail('The coordinator lease lacks a compiler-issued execution descriptor.');
  }
  let descriptor;
  try { descriptor = parseWorkExecutionDescriptor(lease.executionDescriptor); } catch (error) {
    fail(`The compiler-issued execution descriptor is invalid: ${error.message}`);
  }
  if (descriptor.digest !== lease.executionDescriptorDigest
    || descriptor.workItemId !== lease.workItemId
    || descriptor.subjectCoreDigest !== lease.subjectCoreDigest
    || descriptor.runnerRevision !== lease.runnerRevision
    || descriptor.capability !== lease.capability
    || descriptor.resourceClass !== lease.resourceClass
    || descriptor.targetId !== lease.targetId
    || descriptor.entrySpec !== lease.specAffinity) {
    fail('The execution descriptor does not match the active work lease.');
  }
  const childEnvironment = {};
  for (const name of PASSTHROUGH_ENVIRONMENT) {
    if (typeof environment[name] === 'string' && environment[name].length <= 8_192) childEnvironment[name] = environment[name];
  }
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([EXECUTOR]),
    cwd: repositoryRoot,
    environment: Object.freeze({
      ...childEnvironment,
      CI: '1',
      AUDIT_SHARED_EXECUTION_DESCRIPTOR: JSON.stringify(descriptor),
      AUDIT_SHARED_RESULT_IDENTITY: JSON.stringify({
        runId: lease.runId,
        workItemId: lease.workItemId,
        attempt: lease.attempt,
        subjectCoreDigest: lease.subjectCoreDigest,
        runnerRevision: lease.runnerRevision,
        executionDescriptorDigest: descriptor.digest,
      }),
      AUDIT_SHARED_EVIDENCE_DIR: evidenceRoot,
    }),
    descriptor,
  });
}

export const sharedWorkExecutorPath = EXECUTOR;
