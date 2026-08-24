import { readFileSync, writeFileSync } from 'node:fs';
import { ALL_AUDIT_CATALOG, INSTALLED_PLUGIN_REGISTRY, ROUTE_AUDIT_CATALOG } from '../audit/definitions.js';
import { LOCAL_AUDIT_TARGETS } from '../audit/targets.js';

const outputUrl = new URL('../docs/ASSERTION_LEDGER.md', import.meta.url);
const check = process.argv.includes('--check');

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

function codeList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(', ') : '—';
}

const owners = new Map<string, string[]>();
const cases = new Map<string, Array<{
  plugin: string;
  entrySpec: string;
  applicability: string;
  supportedProjects: string[];
}>>();
for (const plugin of INSTALLED_PLUGIN_REGISTRY.plugins) {
  for (const definition of plugin.auditDefinitions) {
    const current = owners.get(definition.id) ?? [];
    current.push(plugin.id);
    owners.set(definition.id, current);
  }
  for (const auditCase of plugin.auditCases) {
    const current = cases.get(auditCase.auditId) ?? [];
    current.push({
      plugin: plugin.id,
      entrySpec: auditCase.entrySpec,
      applicability: auditCase.applicability,
      supportedProjects: [...auditCase.supportedProjects],
    });
    cases.set(auditCase.auditId, current);
  }
}

const automated = ALL_AUDIT_CATALOG.filter(({ manual }) => !manual);
const manual = ALL_AUDIT_CATALOG.filter(({ manual }) => manual);
const releaseBlocking = ALL_AUDIT_CATALOG.filter(({ releaseBlocking }) => releaseBlocking);
const fullSweepProjects = LOCAL_AUDIT_TARGETS.filter((target) => (
  target.fullSweep && !('requiredCapability' in target)
))
  .map(({ id }) => id);
const modes = new Map<string, number>();
for (const definition of ALL_AUDIT_CATALOG) {
  modes.set(definition.evidencePolicy.mode, (modes.get(definition.evidencePolicy.mode) ?? 0) + 1);
}

const lines = [
  '# Assertion and audit contract ledger',
  '',
  'This file is generated from the installed audit catalog and executable plugin registry. It is the reviewer-facing map from each stable audit ID to the product promise, deterministic oracle, evidence policy, executable source, applicability, and browser/device coverage. Edit the catalog, plugin manifests, or test declarations and regenerate this file; do not weaken a row to make a failing product pass.',
  '',
  'The repository validation gate separately rejects literal/self-comparing assertions, swallowed promise failures, conditional-only oracles, observation-only tests, missing executable cases, placeholder contracts, and non-blocking P0/P1 definitions. A generated case proves that a declaration exists; the assertion-quality gate proves that its body contains a non-optional product-facing oracle.',
  '',
  '## Coverage summary',
  '',
  `- Authoritative audit contracts: ${ALL_AUDIT_CATALOG.length}`,
  `- Feature and cross-cutting contracts: ${ALL_AUDIT_CATALOG.length - ROUTE_AUDIT_CATALOG.length}`,
  `- Generated route-specific contracts: ${ROUTE_AUDIT_CATALOG.length}`,
  `- Automated contracts: ${automated.length}`,
  `- Manual physical-device or assistive-technology contracts: ${manual.length}`,
  `- Release-blocking contracts: ${releaseBlocking.length}`,
  `- Evidence modes: ${[...modes].sort().map(([mode, count]) => `${mode} ${count}`).join(', ')}`,
  '',
  '## Per-audit ledger',
  '',
];

for (const definition of ALL_AUDIT_CATALOG) {
  const routeAudit = definition.id.startsWith('PAGE-');
  const auditCases = cases.get(definition.id) ?? (routeAudit ? [{
    plugin: 'platform-routes-content',
    entrySpec: 'tests/page-audit.spec.ts',
    applicability: 'full-sweep-projects',
    supportedProjects: fullSweepProjects,
  }] : []);
  lines.push(
    `### ${definition.id} — ${definition.title}`,
    '',
    `- Area: ${definition.area}`,
    `- Severity and gate: ${definition.severity}; ${definition.releaseBlocking ? 'release blocking' : 'advisory'}`,
    `- Execution: ${definition.manual ? 'manual evidence and attestation required' : 'automated; assertion-quality gate required'}`,
    `- User promise: ${definition.userPromise}`,
    `- Exact expected behavior: ${definition.expected}`,
    `- Primary evidence: ${definition.evidencePolicy.mode} — ${definition.evidencePolicy.rationale}`,
    `- Evidence attachments: ${codeList(definition.evidence)}`,
    `- Owning plugins: ${routeAudit ? '`platform-routes-content` (generated from the reviewed route inventory)' : codeList([...(owners.get(definition.id) ?? [])].sort())}`,
    '',
  );
  if (auditCases.length === 0) {
    lines.push('Manual coverage has no automated source case; the long checklist remains incomplete until a reviewer attaches and attests valid evidence.', '');
    continue;
  }
  lines.push('| Source test | Applicability | Executable browser/device targets |', '| --- | --- | --- |');
  for (const auditCase of auditCases.sort((left, right) => (
    left.entrySpec.localeCompare(right.entrySpec) || left.applicability.localeCompare(right.applicability)
  ))) {
    lines.push(`| \`${cell(auditCase.entrySpec)}\` | \`${cell(auditCase.applicability)}\` | ${codeList(auditCase.supportedProjects)} |`);
  }
  lines.push('');
}

const generated = `${lines.join('\n').trimEnd()}\n`;
if (check) {
  let current = '';
  try {
    current = readFileSync(outputUrl, 'utf8');
  } catch {
    throw new Error('docs/ASSERTION_LEDGER.md is missing; run npm run assertions:ledger.');
  }
  if (current !== generated) throw new Error('docs/ASSERTION_LEDGER.md is stale; run npm run assertions:ledger.');
  process.stdout.write(`Assertion ledger is current: ${ALL_AUDIT_CATALOG.length} contracts.\n`);
} else {
  writeFileSync(outputUrl, generated);
  process.stdout.write(`Wrote docs/ASSERTION_LEDGER.md with ${ALL_AUDIT_CATALOG.length} contracts.\n`);
}
