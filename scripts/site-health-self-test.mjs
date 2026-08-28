import assert from 'node:assert/strict';
import { deriveSiteHealth } from './lib/site-health.mjs';

function input(overrides = {}) {
  const value = {
    schemaVersion: 1,
    mode: 'single-site',
    url: 'https://beta.quitting7oh-org.pages.dev',
    deploymentRole: 'preview',
    scope: { qualifier: 'FULL', selectedCoverage: ['HOME-001', 'SEARCH-001'], omittedCoverage: [] },
    coverage: { finalized: true, manifestIntegrity: true, gaps: [], limitations: [] },
    pipeline: { executionStatus: 'completed', integrityComplete: true, requiredEvidenceComplete: true, reason: 'All required stages completed.' },
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    findings: [],
    manual: { required: 2, complete: 0, failedOrBlocked: 0 },
    visualReview: { items: [{ status: 'absent' }] },
  };
  return {
    ...value,
    ...overrides,
    scope: { ...value.scope, ...(overrides.scope ?? {}) },
    coverage: { ...value.coverage, ...(overrides.coverage ?? {}) },
    pipeline: { ...value.pipeline, ...(overrides.pipeline ?? {}) },
    evidenceAuthority: { ...value.evidenceAuthority, ...(overrides.evidenceAuthority ?? {}) },
    manual: { ...value.manual, ...(overrides.manual ?? {}) },
  };
}

const healthy = deriveSiteHealth(input());
assert.equal(healthy.siteHealth.verdict, 'HEALTHY');
assert.equal(healthy.siteHealth.displayLabel, 'HEALTHY');
assert.equal(healthy.coverage.status, 'COMPLETE');
assert.equal(healthy.manual.status, 'OUTSTANDING', 'Manual work stays co-visible without changing automated health.');
assert.equal(healthy.promotion.authorized, false);

const findings = deriveSiteHealth(input({ findings: [{ id: 'finding-1', severity: 'P1' }] }));
assert.equal(findings.siteHealth.verdict, 'FINDINGS');
assert.equal(findings.siteHealth.findingCount, 1);

const incompleteWithFindings = deriveSiteHealth(input({
  findings: [{ id: 'finding-1', severity: 'P0' }],
  pipeline: { executionStatus: 'incomplete', integrityComplete: false, requiredEvidenceComplete: false, reason: 'Shard signal terminated evidence.' },
}));
assert.equal(incompleteWithFindings.siteHealth.verdict, 'INCOMPLETE', 'Pipeline integrity takes precedence over Findings.');

const cancelled = deriveSiteHealth(input({
  pipeline: { executionStatus: 'cancelled', integrityComplete: false, requiredEvidenceComplete: false, cancellationReason: 'Stopped by operator.' },
}));
assert.equal(cancelled.siteHealth.verdict, 'INCOMPLETE');
assert.equal(cancelled.siteHealth.reason, 'Stopped by operator.');

const targeted = deriveSiteHealth(input({
  scope: { qualifier: 'TARGETED', selectedCoverage: ['HOME-001'], omittedCoverage: ['SEARCH-001'] },
}));
assert.equal(targeted.siteHealth.displayLabel, 'HEALTHY · TARGETED');
assert.equal(targeted.coverage.status, 'COMPLETE', 'Deliberate operator omissions are not Coverage Gaps.');

const nonAuthoritative = deriveSiteHealth(input({
  evidenceAuthority: { status: 'non-authoritative', reasons: ['development-certificate-bypass'] },
}));
assert.equal(nonAuthoritative.siteHealth.verdict, 'HEALTHY');
assert.equal(nonAuthoritative.siteHealth.displayLabel, 'HEALTHY · NON-AUTHORITATIVE');

const gaps = deriveSiteHealth(input({
  coverage: { gaps: ['CONTENT-999 has no standalone Product Oracle'], limitations: ['Rendered navigation unavailable'] },
}));
assert.equal(gaps.coverage.status, 'GAPS');
assert.equal(gaps.siteHealth.verdict, 'HEALTHY', 'Coverage gaps remain separate from deterministic product Findings.');

const unknown = deriveSiteHealth(input({ coverage: { finalized: false, manifestIntegrity: false } }));
assert.equal(unknown.coverage.status, 'UNKNOWN');
assert.equal(unknown.siteHealth.verdict, 'INCOMPLETE');

const visual = deriveSiteHealth(input({
  visualReview: { items: [{ status: 'UNCHANGED' }, { status: 'CHANGED' }, { status: 'REVIEWED' }] },
}));
assert.equal(visual.visualReview.attentionRequired, 1);
assert.equal(visual.siteHealth.verdict, 'HEALTHY', 'Visual review status does not rewrite deterministic Site Health.');

assert.throws(() => deriveSiteHealth({ ...input(), mode: 'comparative' }), /Single-site truth input/);
assert.throws(() => deriveSiteHealth(input({ evidenceAuthority: { status: 'authoritative', reasons: ['unexpected'] } })), /disagree/);
assert.throws(() => deriveSiteHealth({ ...input(), unexpected: true }), /unknown fields/);
assert.throws(() => deriveSiteHealth(input({ url: 'https://beta.quitting7oh-org.pages.dev/path' })), /exact HTTP\(S\) origin/);
assert.throws(() => deriveSiteHealth(input({
  scope: { qualifier: 'TARGETED', selectedCoverage: ['HOME-001'], omittedCoverage: ['HOME-001'] },
})), /overlap/);
assert.throws(() => deriveSiteHealth(input({
  scope: { qualifier: 'FULL', omittedCoverage: ['OMITTED-001'] },
})), /FULL scope cannot/);
assert.throws(() => deriveSiteHealth(input({
  pipeline: { executionStatus: 'cancelled', integrityComplete: false, requiredEvidenceComplete: false },
})), /requires pipeline\.cancellationReason/);

process.stdout.write('Site Health self-test passed: advisory health, coverage, evidence authority, visual review, manual work, and pipeline integrity remain independent and precedence-safe.\n');
