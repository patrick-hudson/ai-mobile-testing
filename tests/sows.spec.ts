import { test, expect, interactionEvidence, interactionTest } from '../fixtures/test.js';
import { meta } from './helpers.js';

const SOWS_PATH = '/mat-suboxone/sows-cows-induction-guide';

function candidateChromium(testInfo: Parameters<typeof meta>[0]): boolean {
  return meta(testInfo).environment === 'candidate' && testInfo.project.name.includes('chromium');
}

async function openCalculator(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Open SOWS calculator' }).click();
  await expect(page.getByRole('list', { name: 'SOWS items' })).toBeVisible();
}

async function answerEveryItem(page: import('@playwright/test').Page, value: number) {
  const groups = page.getByRole('radiogroup', { name: /^Score for:/ });
  const total = await groups.count();
  for (let index = 0; index < total; index += 1) {
    await groups.nth(index).getByRole('radio', { name: new RegExp(`^${value} —`) }).click();
  }
}

interactionTest('[SOWS-001] every withdrawal item contributes exactly to the visible total', interactionEvidence('Answer all sixteen withdrawal items and show the visible score updating to the exact total.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium SOWS audit.');
  await audit.goto(SOWS_PATH);
  await openCalculator(page);

  await audit.step('Confirm the complete questionnaire', 'There are exactly 16 symptom radiogroups and each offers scores zero through four.', async () => {
    const groups = page.getByRole('radiogroup', { name: /^Score for:/ });
    await expect(groups).toHaveCount(16);
    for (let index = 0; index < 16; index += 1) {
      await expect(groups.nth(index).getByRole('radio')).toHaveCount(5);
    }
  });

  await audit.step('Score every item moderately', 'Sixteen answers worth two points produce 32 / 64.', async () => {
    await answerEveryItem(page, 2);
    await expect(page.getByText('32 / 64', { exact: true })).toBeVisible();
    await expect(page.getByText('Very severe withdrawal', { exact: true })).toBeVisible();
  });

  audit.observe('answered symptom count', 16, '16');
  audit.observe('computed score', 32, '32');
  await audit.assertRuntimeHealthy();
});

interactionTest('[SOWS-002] interpretation changes at the induction thresholds', interactionEvidence('Change symptom answers across score thresholds and show each interpretation state responding.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One deterministic candidate desktop threshold audit.');
  await audit.goto(SOWS_PATH);
  await openCalculator(page);
  const groups = page.getByRole('radiogroup', { name: /^Score for:/ });

  await audit.step('Observe the partial-score state', 'An incomplete score below 17 reports progress without induction guidance.', async () => {
    await groups.nth(0).getByRole('radio', { name: /^4 —/ }).click();
    await expect(page.getByText('Score so far: 4.')).toBeVisible();
    await expect(page.getByText('15 items left. Total goes up to 64.')).toBeVisible();
  });

  await audit.step('Reach the at-home induction floor', 'A partial score of 17 explicitly reports the induction window.', async () => {
    for (let index = 1; index <= 13; index += 1) {
      await groups.nth(index).getByRole('radio', { name: /^1 —/ }).click();
    }
    await expect(page.getByText('Probably in the induction window.')).toBeVisible();
  });

  await audit.step('Cross the next threshold', 'A score of at least 21 changes to the past-threshold message.', async () => {
    await groups.nth(14).getByRole('radio', { name: /^4 —/ }).click();
    await expect(page.getByText('Past the threshold — no need to keep scoring.')).toBeVisible();
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[SOWS-003] completed score can be copied, collapsed, reopened, and reset', interactionEvidence('Copy, collapse, reopen, and reset a completed score and show every visible state transition.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium SOWS audit.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.setFixedTime(new Date('2026-08-24T17:42:00-05:00'));
  await audit.goto(SOWS_PATH);
  await openCalculator(page);

  await audit.step('Complete and copy a stable score log', 'Clipboard includes score, severity, and sortable timestamp.', async () => {
    await answerEveryItem(page, 1);
    await page.getByRole('button', { name: 'Copy to clipboard' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^SOWS 16\/64 — Moderate withdrawal — 2026-08-24 17:42$/);
    audit.observe('copied log line', copied, 'Score, severity, and timestamp');
  });

  await audit.step('Collapse and reopen the calculator', 'The closed summary retains the score and all answers remain selected.', async () => {
    await page.getByRole('button', { name: 'Collapse SOWS calculator' }).click();
    await expect(page.getByText('Score: 16 / 64 — tap to reopen')).toBeVisible();
    await page.getByRole('button', { name: 'Open SOWS calculator' }).click();
    await expect(page.getByRole('radio', { name: /^1 —/ }).first()).toHaveAttribute('aria-checked', 'true');
  });

  await audit.step('Reset the score', 'Every answer is cleared and score guidance returns to the initial state.', async () => {
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByText('Score yourself on each item to see where you are.')).toBeVisible();
    await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  });

  await audit.assertRuntimeHealthy();
});
