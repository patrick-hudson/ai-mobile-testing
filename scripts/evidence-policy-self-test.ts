import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AUDIT_CATALOG, pageAuditDefinition } from '../audit/catalog.js';
import {
  createEvidencePolicy,
  evidenceKindsForPolicy,
  parseEvidencePolicyAnnotation,
  serializeEvidencePolicy,
  validateDefinitionEvidencePolicy,
} from '../audit/evidence-policy.js';
import { INSTALLED_PLUGIN_REGISTRY } from '../audit/definitions.js';
import { INTERACTION_VIDEO_PACING_MS, interactionVideoDelayMs } from '../audit/interaction-pacing.js';

for (const [phase, delayMs] of Object.entries(INTERACTION_VIDEO_PACING_MS)) {
  assert(delayMs >= 150, `${phase} must be long enough to be visible to a reviewer.`);
  assert(delayMs <= 2_500, `${phase} must stay bounded so interaction audits remain practical.`);
  assert.equal(interactionVideoDelayMs('interaction-video', phase as keyof typeof INTERACTION_VIDEO_PACING_MS), delayMs);
  assert.equal(interactionVideoDelayMs('static-screenshot', phase as keyof typeof INTERACTION_VIDEO_PACING_MS), 0);
  assert.equal(interactionVideoDelayMs('structured-data', phase as keyof typeof INTERACTION_VIDEO_PACING_MS), 0);
}
assert(
  INTERACTION_VIDEO_PACING_MS['initial-state'] + INTERACTION_VIDEO_PACING_MS['final-outcome'] >= 1_800,
  'Even a one-action clip must establish context and leave a reviewable final outcome.',
);
assert(
  INTERACTION_VIDEO_PACING_MS['secondary-outcome'] >= 2_000,
  'A legitimate popup outcome must remain visible long enough to survive the media quality gate.',
);

const catalogCounts = { 'interaction-video': 0, 'static-screenshot': 0, 'structured-data': 0 };
for (const definition of AUDIT_CATALOG) {
  validateDefinitionEvidencePolicy(definition, definition.id);
  catalogCounts[definition.evidencePolicy.mode] += 1;
}
assert.equal(AUDIT_CATALOG.length, 81);
assert.deepEqual(catalogCounts, {
  'interaction-video': 43,
  'static-screenshot': 33,
  'structured-data': 5,
});

const pageDefinition = pageAuditDefinition('/example/route');
assert.equal(pageDefinition.evidencePolicy.mode, 'static-screenshot');
assert.equal(pageDefinition.evidence.includes('screenshot'), true);
assert.equal(pageDefinition.evidence.includes('video'), false);

const mixedDefinition = AUDIT_CATALOG.find(({ id }) => id === 'A11Y-001');
assert(mixedDefinition);
const overlayPolicy = createEvidencePolicy(
  'interaction-video',
  'Open the search dialog and show its focused state while scanning the accessible tree.',
);
assert.deepEqual(
  evidenceKindsForPolicy(mixedDefinition.evidence, overlayPolicy),
  ['video', 'axe', 'json'],
  'A mixed audit must require video only for its interaction execution.',
);
assert.deepEqual(
  evidenceKindsForPolicy(mixedDefinition.evidence, mixedDefinition.evidencePolicy),
  ['screenshot', 'axe', 'json'],
  'Static executions of a mixed audit must require screenshots, not video.',
);
assert.deepEqual(
  parseEvidencePolicyAnnotation([{
    type: 'audit-evidence-policy',
    description: serializeEvidencePolicy(overlayPolicy),
  }]),
  overlayPolicy,
);
assert.equal(parseEvidencePolicyAnnotation([]), null);

const repositoryRoot = process.cwd();
const enabledSpecs = [...new Set(INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ entrySpecs }) => entrySpecs))];
let interactionDeclarations = 0;
let staticDeclarations = 0;
let structuredDeclarations = 0;
for (const entrySpec of enabledSpecs) {
  const source = readFileSync(path.join(repositoryRoot, entrySpec), 'utf8');
  assert.doesNotMatch(
    source,
    /^\s*test\s*\(/m,
    `${entrySpec} registers an audit without an explicit evidence helper.`,
  );
  interactionDeclarations += [...source.matchAll(/\binteractionTest\s*\(/g)].length;
  staticDeclarations += [...source.matchAll(/\bstaticTest\s*\(/g)].length;
  structuredDeclarations += [...source.matchAll(/\bstructuredTest\s*\(/g)].length;
  assert.equal(
    [...source.matchAll(/\binteractionTest\s*\([^\n]*\binteractionEvidence\s*\(/g)].length,
    [...source.matchAll(/\binteractionTest\s*\(/g)].length,
    `${entrySpec} has an interaction test without a matching action/response rationale.`,
  );
  for (const declaration of source.split(/(?=^(?:interactionTest|staticTest|structuredTest)\s*\()/m)) {
    if (!declaration.startsWith('interactionTest(')) continue;
    assert.match(
      declaration,
      /\baudit\.step\s*\(/,
      `${entrySpec} has an interaction test without a labeled audit.step action/response checkpoint.`,
    );
  }
  assert.equal(
    [...source.matchAll(/\bstaticTest\s*\([^\n]*\bstaticEvidence\s*\(/g)].length,
    [...source.matchAll(/\bstaticTest\s*\(/g)].length,
    `${entrySpec} has a static test without a matching screenshot rationale.`,
  );
  assert.equal(
    [...source.matchAll(/\bstructuredTest\s*\([^\n]*\bstructuredEvidence\s*\(/g)].length,
    [...source.matchAll(/\bstructuredTest\s*\(/g)].length,
    `${entrySpec} has a data-only test without a matching structured-evidence rationale.`,
  );
}
assert.deepEqual(
  { interactionDeclarations, staticDeclarations, structuredDeclarations },
  { interactionDeclarations: 39, staticDeclarations: 35, structuredDeclarations: 5 },
);

process.stdout.write(
  'Evidence policy self-test passed: 81 catalog audits and 79 enabled test declarations explicitly separate evidence modes; all interaction clips have bounded pacing and a labeled action/response checkpoint.\n',
);
