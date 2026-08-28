import { expect, staticEvidence, staticTest } from '../../../fixtures/test.js';
import type { AuditDefinition } from '../../../audit/types.js';

const starterDefinition = {
  id: 'STARTER-001',
  area: 'content',
  title: 'Replace this sample audit',
  userPromise: 'Describe the user-facing behavior protected by the plugin.',
  severity: 'P2',
  releaseBlocking: false,
  expected: 'Replace this with an observable result, not a status-only assertion.',
  evidence: ['screenshot', 'json'],
  evidencePolicy: {
    mode: 'static-screenshot',
    rationale: 'Capture the rendered sample state and its structured audit observations.',
  },
  singleSiteClassification: 'standalone-compatible',
  standaloneOracle: {
    id: 'STARTER-001:standalone',
    expected: 'Replace this with an observable result, not a status-only assertion.',
  },
} satisfies AuditDefinition;

staticTest('[STARTER-001] replace this starter with an evidence-rich user outcome', staticEvidence('Capture the rendered sample state with its heading and structured observation.', 'candidate-mobile-chromium'), async ({ page, audit }) => {
  audit.setDefinition(starterDefinition);
  await audit.goto('/');
  await expect(page.locator('main')).toBeVisible();
  audit.observe('Replace this observation', true, 'A meaningful expected value');
  await audit.checkpoint('replace-this-checkpoint');
});
