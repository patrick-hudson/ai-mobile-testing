import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUDIT_CASE_ID_ANNOTATION, type ExecutableAuditCaseRegistry } from '../audit/execution-selection.js';
import { SINGLE_SITE_FULL_PROFILE_TARGET_IDS, SINGLE_SITE_LOCAL_AUDIT_TARGETS } from '../audit/targets.js';

const registry = JSON.parse(
  readFileSync(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8'),
) as ExecutableAuditCaseRegistry;
const targetById = new Map(SINGLE_SITE_LOCAL_AUDIT_TARGETS.map((target) => [target.id, target]));
const selectedTargets = SINGLE_SITE_FULL_PROFILE_TARGET_IDS.map((targetId) => targetById.get(targetId)!);
const selectedCases = registry.plugins.flatMap(({ auditCases }) => auditCases)
  .filter((auditCase) => auditCase.supportedModes.includes('single-site')
    && selectedTargets.some((target) => auditCase.supportedProjects.includes(target.sourceComparativeTargetId)));
const expectedExecutions = new Set(selectedCases.flatMap((auditCase) => selectedTargets
  .filter((target) => auditCase.supportedProjects.includes(target.sourceComparativeTargetId))
  .map((target) => `${auditCase.caseId}@${target.id}`)));

const outputRoot = mkdtempSync(path.join(os.tmpdir(), 'single-site-enumeration-'));
const stdoutPath = path.join(outputRoot, 'playwright-list.stdout');
const stderrPath = path.join(outputRoot, 'playwright-list.stderr');
const stdoutFd = openSync(stdoutPath, 'w');
const stderrFd = openSync(stderrPath, 'w');
let child;
try {
  child = spawnSync(process.execPath, [
    './node_modules/@playwright/test/cli.js',
    'test',
    '--list',
    '--reporter=json',
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      AUDIT_RUN_MODE: 'single-site',
      AUDIT_SINGLE_SITE_URL: 'https://beta.quitting7oh-org.pages.dev',
      AUDIT_SINGLE_SITE_ROLE: 'preview',
      AUDIT_SINGLE_SITE_CERTIFICATE_POLICY: 'strict',
      AUDIT_TARGET_IDS: selectedTargets.map(({ id }) => id).join(','),
      AUDIT_SINGLE_SITE_CASE_IDS: JSON.stringify(selectedCases.map(({ caseId }) => caseId)),
      AUDIT_SINGLE_SITE_EGRESS_PROXY: 'http://127.0.0.1:1',
      CANDIDATE_IGNORE_HTTPS_ERRORS: '0',
    },
    stdio: ['ignore', stdoutFd, stderrFd],
  });
} finally {
  closeSync(stdoutFd);
  closeSync(stderrFd);
}
const stdout = readFileSync(stdoutPath, 'utf8');
const stderr = readFileSync(stderrPath, 'utf8');
rmSync(outputRoot, { recursive: true, force: true });
if (child.status !== 0) {
  throw new Error(`Single-site Playwright enumeration failed (${child.status}):\n${stdout}\n${stderr}`);
}
const jsonStart = stdout.indexOf('{\n  "config"');
if (jsonStart < 0) throw new Error(`Playwright JSON enumeration was not found:\n${stdout}`);
const report = JSON.parse(stdout.slice(jsonStart)) as {
  suites: Array<unknown>;
  errors: unknown[];
};
assert.deepEqual(report.errors, [], 'Playwright collection must not report configuration or declaration errors.');

const observedExecutions: string[] = [];
function visit(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.tests)) {
    for (const test of record.tests as Array<Record<string, unknown>>) {
      const annotations = Array.isArray(test.annotations)
        ? test.annotations as Array<{ type?: unknown; description?: unknown }>
        : [];
      const caseIds = annotations
        .filter(({ type }) => type === AUDIT_CASE_ID_ANNOTATION)
        .map(({ description }) => description)
        .filter((description): description is string => typeof description === 'string' && description.length > 0);
      assert.equal(caseIds.length, 1, `Every Single-site Playwright row must bind one exact compiled case ID: ${String(record.title)}`);
      assert.equal(typeof test.projectName, 'string');
      observedExecutions.push(`${caseIds[0]}@${test.projectName as string}`);
    }
  }
  for (const childValue of Object.values(record)) {
    if (Array.isArray(childValue)) childValue.forEach(visit);
  }
}
report.suites.forEach(visit);

const duplicateExecutions = [...new Set(observedExecutions.filter((value, index) => observedExecutions.indexOf(value) !== index))];
assert.deepEqual(duplicateExecutions, [], 'A compiled case/target execution must enumerate exactly one Playwright row.');
const observed = new Set(observedExecutions);
assert.deepEqual([...observed].sort(), [...expectedExecutions].sort(), 'Playwright enumeration must equal the compiler-compatible case/target matrix exactly.');

process.stdout.write(
  `Single-site enumeration self-test passed: ${selectedCases.length} exact cases produced ${observed.size} unique executions across ${selectedTargets.length} neutral targets, with no comparison skips.\n`,
);
