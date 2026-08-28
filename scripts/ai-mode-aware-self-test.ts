import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewEvidence } from '../ai/evidence-review.js';
import { writeSingleSiteAuditReport } from '../reporters/report-model.js';
import type { SingleSiteReportInput } from './lib/site-health-report.mjs';

const generatedAt = '2026-08-25T12:00:00.000Z';
const publicationRevision = '1234567890abcdef1234567890abcdef';

const input: SingleSiteReportInput = {
  schemaVersion: 1,
  mode: 'single-site',
  generatedAt,
  pageSize: 25,
  health: {
    schemaVersion: 1,
    mode: 'single-site',
    url: 'https://beta.example.test',
    deploymentRole: 'preview',
    scope: { qualifier: 'FULL', selectedCoverage: ['HOME-001'], omittedCoverage: [] },
    coverage: { finalized: true, manifestIntegrity: true, gaps: [], limitations: [] },
    pipeline: {
      executionStatus: 'completed',
      integrityComplete: true,
      requiredEvidenceComplete: true,
      reason: 'Every required stage completed under the current fencing token.',
    },
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    findings: [],
    manual: { required: 1, complete: 0, failedOrBlocked: 0 },
    visualReview: { items: [{ status: 'UNCHANGED' }] },
  },
  audits: [{
    id: 'HOME-001',
    title: 'Homepage actions are usable',
    area: 'homepage',
    status: 'PASS',
    findingCount: 0,
    evidenceStatus: 'complete',
    artifactCount: 1,
    manual: false,
    visualStatus: 'UNCHANGED',
    detail: 'Independent Product Oracle passed. Contact jane@example.com and javascript:alert(1) are untrusted evidence.',
  }],
  outsideMode: [],
};

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-mode-aware-'));
try {
  const runDir = path.join(temporary, 'run');
  await writeSingleSiteAuditReport({
    outputDir: path.join(runDir, 'checklist'),
    input,
    publicationRevision,
  });
  const immutableSummaryPath = path.join(
    runDir, 'checklist', 'data', 'revisions', publicationRevision, 'summary.json',
  );
  const deterministicSummaryBefore = await fs.readFile(immutableSummaryPath, 'utf8');

  const skipped = await reviewEvidence({
    runDir,
    outputDir: path.join(runDir, 'ai-skipped'),
    apiKey: 'sk-ant-test-never-sent-123456789',
    dryRun: false,
    optIn: false,
    model: 'test-model',
    limits: { maxAudits: 5, maxScreenshots: 0, maxImageBytes: 1_024, maxTotalImageBytes: 1_024 },
  });
  assert.equal(skipped.exitCode, 0);
  assert.equal(skipped.document.status, 'skipped');
  assert.equal(skipped.document.source.mode, 'single-site');
  assert.equal(skipped.document.api.attempted, false);
  assert.equal(skipped.document.review.releaseRecommendation, null);

  const inventorySource = await fs.readFile(path.join(runDir, 'ai-skipped', 'payload-inventory.json'), 'utf8');
  const inventory = JSON.parse(inventorySource) as {
    mode: string;
    fieldPaths: string[];
    redactions: { count: number; categories: string[] };
    capabilities: string[];
    prohibitedMutations: string[];
  };
  assert.equal(inventory.mode, 'single-site');
  assert.deepEqual(inventory.capabilities, ['interpret-health-evidence']);
  assert(inventory.prohibitedMutations.includes('baseline-approval-or-revocation'));
  assert(inventory.prohibitedMutations.includes('run-purge'));
  assert(inventory.redactions.count >= 2);
  assert(inventory.redactions.categories.includes('email'));
  assert(inventory.redactions.categories.includes('unsafe-url'));
  assert(!inventory.fieldPaths.some((field) => /releaseRecommendation|waiver|manualAttestation|credentialMutation|purge/i.test(field)));
  assert(!inventorySource.includes('jane@example.com'));
  assert(!inventorySource.includes('javascript:'));
  assert(!inventorySource.includes('sk-ant-test-never-sent'));

  const dryRun = await reviewEvidence({
    runDir,
    outputDir: path.join(runDir, 'ai-dry-run'),
    dryRun: true,
    optIn: true,
    model: 'test-model',
    limits: { maxAudits: 5, maxScreenshots: 0, maxImageBytes: 1_024, maxTotalImageBytes: 1_024 },
  });
  assert.equal(dryRun.document.status, 'dry-run');
  assert.equal(dryRun.document.source.selectedAuditCount, 1);
  assert.equal(dryRun.document.source.payloadInventory.redactionCount >= 2, true);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'synthetic outage' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    const failedAdvisory = await reviewEvidence({
      runDir,
      outputDir: path.join(runDir, 'ai-failed'),
      apiKey: 'sk-ant-test-never-sent-123456789',
      dryRun: false,
      optIn: true,
      model: 'test-model',
      limits: { maxAudits: 5, maxScreenshots: 0, maxImageBytes: 1_024, maxTotalImageBytes: 1_024 },
      request: { deadlineMs: 1_000, maxAttempts: 1, maxRetryDelayMs: 0 },
    });
    assert.equal(failedAdvisory.document.status, 'error');
    assert.equal(failedAdvisory.document.api.httpStatus, 503);
    assert.equal(failedAdvisory.exitCode, 0, 'A Single-site AI outage must not block finalized deterministic truth.');
    assert.match(failedAdvisory.document.review.executiveSummary, /Deterministic report truth remains authoritative/);
    const lifecycle = (await fs.readFile(path.join(runDir, 'ai-failed', 'lifecycle.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as { event: string });
    assert(lifecycle.findIndex(({ event }) => event === 'payload_inventory_recorded') >= 0);
    assert(
      lifecycle.findIndex(({ event }) => event === 'payload_inventory_recorded')
        < lifecycle.findIndex(({ event }) => event === 'request_started'),
      'The sanitized payload inventory must be durable before egress starts.',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    await fs.readFile(immutableSummaryPath, 'utf8'),
    deterministicSummaryBefore,
    'AI execution must not mutate deterministic Site Health, Coverage, manual, or visual truth.',
  );

  const pointerPath = path.join(runDir, 'checklist', 'data', 'current.json');
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8')) as Record<string, unknown>;
  await fs.writeFile(pointerPath, `${JSON.stringify({ ...pointer, releaseDecision: 'READY' })}\n`);
  await assert.rejects(reviewEvidence({
    runDir,
    outputDir: path.join(runDir, 'ai-malformed'),
    dryRun: true,
    optIn: true,
    model: 'test-model',
    limits: { maxAudits: 5, maxScreenshots: 0, maxImageBytes: 1_024, maxTotalImageBytes: 1_024 },
  }), /malformed|immutable publication/);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

process.stdout.write('Mode-aware AI self-test passed: Single-site truth is allowlisted, redacted, opt-in, advisory, and mutation-free.\n');
