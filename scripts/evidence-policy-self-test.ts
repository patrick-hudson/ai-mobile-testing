import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AUDIT_CATALOG, pageAuditDefinition } from '../audit/catalog.js';
import {
  AUDIT_APPLICABILITY_ANNOTATION,
  AUDIT_STATUS_ANNOTATION,
  AUDIT_STATUS_WAIVER_ANNOTATION,
  assertEvidenceAuthority,
  assertProjectEvidenceAuthority,
  assertStaticCheckpoint,
  createEvidencePolicy,
  evidenceKindsForPolicy,
  evidenceAuthority,
  parseAuditStatusAnnotation,
  parseAuditApplicabilityAnnotation,
  parseEvidencePolicyAnnotation,
  serializeEvidencePolicy,
  validateDefinitionEvidencePolicy,
} from '../audit/evidence-policy.js';
import { parseAuditProjectMetadata, projectMetadata } from '../audit/environments.js';
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
  INTERACTION_VIDEO_PACING_MS['initial-state']
    + INTERACTION_VIDEO_PACING_MS['before-action']
    + INTERACTION_VIDEO_PACING_MS.response
    + INTERACTION_VIDEO_PACING_MS['final-outcome'] >= 2_300,
  'A contextual one-action journey must remain safely above the two-second media evidence floor.',
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
assert.equal(
  Object.values(catalogCounts).reduce((total, count) => total + count, 0),
  AUDIT_CATALOG.length,
);
for (const [mode, count] of Object.entries(catalogCounts)) {
  assert(count > 0, `The catalog must exercise ${mode} policy validation.`);
}

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
assert.equal(
  parseAuditApplicabilityAnnotation([{ type: AUDIT_APPLICABILITY_ANNOTATION, description: 'candidate-desktop-chromium' }]),
  'candidate-desktop-chromium',
);
assert.equal(
  parseAuditApplicabilityAnnotation([{ type: AUDIT_APPLICABILITY_ANNOTATION, description: 'candidate-ish' }]),
  null,
);
assert.equal(parseAuditApplicabilityAnnotation([]), null);
assert.equal(
  assertStaticCheckpoint(
    createEvidencePolicy('static-screenshot', 'Capture the asserted placement of the rendered warning.'),
    'rendered warning placement',
  ),
  'rendered warning placement',
);
assert.throws(
  () => assertStaticCheckpoint(overlayPolicy, 'search dialog'),
  /only valid for static-screenshot/,
);
assert.throws(
  () => assertStaticCheckpoint(
    createEvidencePolicy('static-screenshot', 'Capture one purposeful rendered state for review.'),
    'automatic-static-evidence',
  ),
  /purposeful name/,
);
assert.equal(
  parseAuditStatusAnnotation([{ type: AUDIT_STATUS_ANNOTATION, description: 'BLOCKED' }], 'A11Y-001'),
  'BLOCKED',
);
assert.equal(
  parseAuditStatusAnnotation([{ type: 'note', description: 'Storage was blocked during this passing audit.' }], 'REL-002'),
  null,
  'Ordinary prose must never control checklist status.',
);
assert.throws(
  () => parseAuditStatusAnnotation([{ type: AUDIT_STATUS_ANNOTATION, description: 'blocked' }], 'A11Y-001'),
  /exactly REVIEW, INTENDED_CHANGE, or BLOCKED/,
);
assert.throws(
  () => parseAuditStatusAnnotation([{ type: AUDIT_STATUS_ANNOTATION, description: 'INTENDED_CHANGE' }], 'A11Y-001'),
  /requires exactly one audit-status-waiver/,
);
assert.equal(
  parseAuditStatusAnnotation([
    { type: AUDIT_STATUS_ANNOTATION, description: 'INTENDED_CHANGE' },
    {
      type: AUDIT_STATUS_WAIVER_ANNOTATION,
      description: JSON.stringify({
        status: 'INTENDED_CHANGE',
        auditId: 'A11Y-001',
        reason: 'The approved redesign intentionally changes this reviewed state.',
        approvedBy: 'Release owner',
      }),
    },
  ], 'A11Y-001'),
  'INTENDED_CHANGE',
);

assert.deepEqual(evidenceAuthority(), { status: 'authoritative', reasons: [] });
assert.deepEqual(evidenceAuthority(['deployment-revision-unavailable', 'development-certificate-bypass']), {
  status: 'non-authoritative',
  reasons: ['development-certificate-bypass', 'deployment-revision-unavailable'],
});
assert.throws(
  () => assertEvidenceAuthority({ status: 'authoritative', reasons: ['deployment-revision-unavailable'] }),
  /inconsistent or not canonically ordered/,
);
assert.throws(
  () => assertEvidenceAuthority({ status: 'non-authoritative', reasons: [] }),
  /inconsistent or not canonically ordered/,
);

const strictSingleSiteMetadata = parseAuditProjectMetadata({
  mode: 'single-site',
  deploymentRole: 'preview',
  sourceComparativeTargetId: 'candidate-mobile-chromium',
  baseURL: 'https://beta.quitting7oh-org.pages.dev/',
  browserLabel: 'Chromium / mobile',
  deviceClass: 'mobile',
  fullSweep: true,
  visual: true,
  tlsPolicy: 'strict',
  evidenceAuthority: { status: 'authoritative', reasons: [] },
});
assert.equal(strictSingleSiteMetadata.mode, 'single-site');
assert.equal(strictSingleSiteMetadata.baseURL, 'https://beta.quitting7oh-org.pages.dev');
assert.equal('environment' in strictSingleSiteMetadata, false);

const bypassSingleSiteMetadata = parseAuditProjectMetadata({
  ...strictSingleSiteMetadata,
  tlsPolicy: 'preview-bypass',
  evidenceAuthority: { status: 'non-authoritative', reasons: ['development-certificate-bypass'] },
});
assert.deepEqual(assertProjectEvidenceAuthority(bypassSingleSiteMetadata), bypassSingleSiteMetadata.evidenceAuthority);
assert.throws(() => parseAuditProjectMetadata({
  ...bypassSingleSiteMetadata,
  deploymentRole: 'production',
}), /Production-role Single-site/);
assert.throws(() => parseAuditProjectMetadata({
  ...strictSingleSiteMetadata,
  environment: 'candidate',
}), /mixed mode fields/);
assert.equal(projectMetadata({ environment: 'candidate' }).mode, 'comparative');
assert.throws(() => projectMetadata(strictSingleSiteMetadata), /cannot read explicit Single-site/);

const repositoryRoot = process.cwd();
const enabledSpecs = [...new Set(INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ entrySpecs }) => entrySpecs))];
let interactionDeclarations = 0;
let staticDeclarations = 0;
let structuredDeclarations = 0;
let standaloneStaticDeclarations = 0;
let inventoriedStaticDeclarations = 0;
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
  standaloneStaticDeclarations += [...source.matchAll(/\bstandaloneStaticTest\s*\(/g)].length;
  inventoriedStaticDeclarations += [...source.matchAll(/\binventoriedStaticTest\s*\(/g)].length;
  assert.equal(
    [...source.matchAll(/\binteractionTest\s*\([^\n]*\binteractionEvidence\s*\(/g)].length,
    [...source.matchAll(/\binteractionTest\s*\(/g)].length,
    `${entrySpec} has an interaction test without a matching action/response rationale.`,
  );
  for (const declaration of source.split(/(?=^(?:interactionTest|staticTest|structuredTest)\s*\()/m)) {
    if (declaration.startsWith('interactionTest(')) {
      assert.match(
        declaration,
        /\baudit\.step\s*\(/,
        `${entrySpec} has an interaction test without a labeled audit.step action/response checkpoint.`,
      );
      assert.doesNotMatch(
        declaration,
        /\baudit\.checkpoint\s*\(/,
        `${entrySpec} uses a static screenshot as primary evidence for an interaction-video audit.`,
      );
    }
    if (declaration.startsWith('structuredTest(')) {
      assert.doesNotMatch(
        declaration,
        /\baudit\.checkpoint\s*\(/,
        `${entrySpec} uses a decorative screenshot in a structured-data audit.`,
      );
    }
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
  assert.equal(
    [...source.matchAll(/\binventoriedStaticTest\s*\([^\n]*\bstaticEvidence\s*\(/g)].length,
    [...source.matchAll(/\binventoriedStaticTest\s*\(/g)].length,
    `${entrySpec} has an inventoried static test without a matching screenshot rationale.`,
  );
}
assert(interactionDeclarations > 0, 'Enabled plugins must include interaction evidence.');
assert(staticDeclarations > 0, 'Enabled plugins must include static evidence.');
assert(structuredDeclarations > 0, 'Enabled plugins must include structured evidence.');
assert(standaloneStaticDeclarations > 0, 'Enabled plugins must include an explicit standalone-only evidence case.');
assert(inventoriedStaticDeclarations > 0, 'Enabled plugins must register frozen inventoried routes through an explicit evidence helper.');

process.stdout.write(
  `Evidence policy self-test passed: ${AUDIT_CATALOG.length} catalog audits and ${interactionDeclarations + staticDeclarations + structuredDeclarations + standaloneStaticDeclarations + inventoriedStaticDeclarations} enabled test declarations explicitly separate evidence modes; all interaction clips have bounded pacing and a labeled action/response checkpoint.\n`,
);
