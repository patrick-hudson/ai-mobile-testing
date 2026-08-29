import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUDIT_CASE_ID_ANNOTATION, type ExecutableAuditCaseRegistry } from '../audit/execution-selection.js';
import { SINGLE_SITE_FULL_PROFILE_TARGET_IDS, SINGLE_SITE_LOCAL_AUDIT_TARGETS } from '../audit/targets.js';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import {
  canonicalPlaywrightSelection,
  compileCanonicalExecutionGraph,
  compileSingleSiteInventoryBarrier,
  completeSingleSiteInventoryBarrier,
} from '../shared/execution-graph-compiler.mjs';
import { sealReleaseSubjectCore } from '../shared/release-subject.mjs';

type RegistryDocument = {
  schemaVersion: 1;
  plugins: Array<{
    auditCases: ExecutableAuditCaseRegistry['plugins'][number]['auditCases'];
    auditDefinitions: Array<{ id: string; area: string; manual: boolean; singleSiteClassification: string }>;
  }>;
};
const registry = JSON.parse(
  readFileSync(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8'),
) as RegistryDocument;
const targetRegistry = JSON.parse(
  readFileSync(new URL('../audit/targets.generated.json', import.meta.url), 'utf8'),
);
const targetById = new Map(SINGLE_SITE_LOCAL_AUDIT_TARGETS.map((target) => [target.id, target]));
const selectedTargets = SINGLE_SITE_FULL_PROFILE_TARGET_IDS.map((targetId) => targetById.get(targetId)!);
const outputRoot = mkdtempSync(path.join(os.tmpdir(), 'single-site-enumeration-'));
const selectedDefinitions = registry.plugins.flatMap(({ auditDefinitions, auditCases }) => auditDefinitions
  .filter((definition) => !definition.manual && definition.singleSiteClassification !== 'comparison-only')
  .filter((definition) => auditCases.some((auditCase) => auditCase.auditId === definition.id
    && auditCase.supportedModes.includes('single-site')
    && selectedTargets.some((target) => auditCase.supportedProjects.includes(target.sourceComparativeTargetId)))));
const subjectCore = sealReleaseSubjectCore({
  schemaVersion: 1,
  deploymentIdentity: { kind: 'build', value: 'enumeration-fixture' },
  targets: [{ role: 'audited', origin: 'https://beta.quitting7oh-org.pages.dev' }],
  mode: 'single-site',
  requestedAuthority: {
    qualifier: 'FULL',
    scope: {
      features: [...new Set(selectedDefinitions.map(({ area }) => area))].sort(),
      definitions: selectedDefinitions.map(({ id }) => id).sort(),
      targets: [...SINGLE_SITE_FULL_PROFILE_TARGET_IDS].sort(),
      knownLimits: [],
    },
  },
  revisions: {
    runner: `sha256:${'1'.repeat(64)}`,
    plugins: canonicalDigest(registry),
    targets: canonicalDigest(targetRegistry),
    configuration: `sha256:${'2'.repeat(64)}`,
  },
  environmentIdentity: `sha256:${'3'.repeat(64)}`,
  certificatePolicy: 'strict',
});
const barrier = compileSingleSiteInventoryBarrier({ subjectCore, pluginRegistry: registry, targetRegistry });
const graph = compileCanonicalExecutionGraph({
  subjectCore,
  pluginRegistry: registry,
  targetRegistry,
  inventoryCompletion: completeSingleSiteInventoryBarrier({
    subjectCore,
    barrier,
    attempt: 1,
    routeInventory: {
      schemaVersion: 1,
      origin: 'https://beta.quitting7oh-org.pages.dev',
      routes: [{ url: 'https://beta.quitting7oh-org.pages.dev', path: '/', query: '', disposition: 'included', sources: [] }],
      limitations: [],
      failures: [],
    },
    deploymentIdentityRecheck: subjectCore.deploymentIdentity,
  }),
  deploymentIdentityRecheck: subjectCore.deploymentIdentity,
});
const selection = canonicalPlaywrightSelection(graph);
const expectedExecutions = new Set(graph.workItemPlans.map(({ caseId, targetId }) => `${caseId}@${targetId}`));
const canonicalGraphPath = path.join(outputRoot, 'canonical-graph.json');
writeFileSync(canonicalGraphPath, `${JSON.stringify(graph)}\n`);
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
      AUDIT_CANONICAL_GRAPH_PATH: canonicalGraphPath,
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
  `Single-site enumeration self-test passed: ${selection.caseIds.length} exact canonical cases produced ${observed.size} unique executions across ${selection.targetIds.length} neutral targets, with no comparison skips.\n`,
);
