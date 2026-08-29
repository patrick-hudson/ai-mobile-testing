import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { auditCaseTag, AUDIT_CASE_ID_ANNOTATION } from '../../shared/audit-case-identity.mjs';
import {
  SHARED_DOCKER_RESILIENCE_CASES,
  SHARED_DOCKER_RESILIENCE_ENV,
  SHARED_DOCKER_RESILIENCE_EVIDENCE_POLICY,
} from '../../shared/shared-docker-resilience-contract.mjs';

const enabled = process.env[SHARED_DOCKER_RESILIENCE_ENV] === '1';

for (const proof of SHARED_DOCKER_RESILIENCE_CASES) {
  test.describe(() => {
    test.skip(!enabled, 'The frozen shared-runner proof executes only in its isolated Docker profile.');
    test(`shared runner completes ${proof.auditId}`, {
      tag: auditCaseTag(proof.caseId),
      annotation: [
        { type: AUDIT_CASE_ID_ANNOTATION, description: proof.caseId },
        { type: 'audit-evidence-policy', description: JSON.stringify(SHARED_DOCKER_RESILIENCE_EVIDENCE_POLICY) },
      ],
    }, async ({ page }, testInfo) => {
      await page.setContent(`<main><h1>${proof.auditId}</h1><p>frozen shared runner proof</p></main>`);
      await expect(page.getByRole('heading', { name: proof.auditId })).toBeVisible();
      // These two ordered cases provide a durable in-flight boundary for the
      // 1→2→1, worker-crash, and coordinator-crash scenarios. The harness
      // confirms the exact active lease immediately before injecting failure.
      await page.waitForTimeout(proof.delayMs);

      const baseURL = String(testInfo.project.use.baseURL);
      const summary = {
        schemaVersion: 1,
        caseId: proof.caseId,
        auditId: proof.auditId,
        mode: 'single-site',
        deploymentRole: 'preview',
        baseURL,
        project: testInfo.project.name,
        findings: [],
        steps: [],
      };
      const record = { ...summary, evidencePolicy: SHARED_DOCKER_RESILIENCE_EVIDENCE_POLICY };
      const recordPath = testInfo.outputPath('audit-result.json');
      await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await testInfo.attach('audit-result', { path: recordPath, contentType: 'application/json' });
      await testInfo.attach('audit-result-summary', {
        body: Buffer.from(JSON.stringify(summary)),
        contentType: 'application/json',
      });
      if (proof.expectedOutcome === 'completed_product_failure') {
        const diagnosticPath = testInfo.outputPath('intentional-product-failure.png');
        await page.screenshot({ path: diagnosticPath, animations: 'disabled', caret: 'hide' });
        await testInfo.attach('intentional-product-failure', {
          path: diagnosticPath,
          contentType: 'image/png',
        });
        await expect(page.getByRole('heading', { name: proof.auditId }))
          .toHaveText('intentional product failure');
      }
    });
  });
}
