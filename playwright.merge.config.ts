import { defineConfig } from '@playwright/test';

const artifactRoot = process.env.AUDIT_ARTIFACT_DIR ?? './artifacts/sharded/merged';

export default defineConfig({
  reporter: [
    ['list'],
    ['./reporters/live-gallery-reporter.ts', { outputDir: artifactRoot }],
    ['./reporters/checklist-reporter.ts', { outputDir: `${artifactRoot}/checklist` }],
    ['html', { outputFolder: `${artifactRoot}/playwright-html`, open: 'never' }],
    ['json', { outputFile: `${artifactRoot}/results.json` }],
  ],
});
