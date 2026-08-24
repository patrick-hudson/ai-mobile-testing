import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { meta, pageHasHorizontalOverflow } from './helpers.js';
import type { Page } from '@playwright/test';

const TAPER_PATH = '/resources/7-oh-taper-calculator';
const SR17_PATH = '/resources/sr-17-taper-calculator';

function candidateChromium(testInfo: Parameters<typeof meta>[0]): boolean {
  const project = meta(testInfo);
  return project.environment === 'candidate' && testInfo.project.name.includes('chromium');
}

async function replaceNumber(page: import('@playwright/test').Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.blur();
}

interface AdvancedScheduleRow {
  day: string;
  phase: string;
  sr17: string;
  source: string;
}

interface TaperScheduleRow {
  day: number;
  perDose: number;
  times: number;
  total: number;
}

interface SimpleScheduleRow {
  range: string;
  phase: string;
  sevenOhPerDose: number | null;
  sevenOhDoses: number;
  sevenOhTotal: number;
  srPerDose: number;
  srDoses: number;
  srTotal: number;
}

async function readTaperSchedule(page: Page): Promise<TaperScheduleRow[]> {
  return page.locator('tr.schedule-data-row').evaluateAll((rows) => rows.map((row) => {
    const read = (label: string) => Number(row.querySelector<HTMLElement>(`[data-label="${label}"]`)?.innerText.trim());
    return {
      day: read('Day'),
      perDose: read('Per dose (mg)'),
      times: read('Times/day'),
      total: read('Total daily (mg)'),
    };
  }));
}

async function readSimpleSchedule(page: Page): Promise<SimpleScheduleRow[]> {
  return page.locator('[data-simple-sr17-step]').evaluateAll((steps) => steps.map((step) => {
    const range = step.getAttribute('data-simple-sr17-step') ?? '';
    const phase = step.querySelector(':scope > div:first-child p:nth-child(2)')?.textContent?.trim() ?? '';
    const columns = step.querySelectorAll(':scope > div:nth-child(2) > div');
    const sevenOhText = columns[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const srText = columns[1]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const sevenOh = sevenOhText.match(/7-OH\s+([\d.]+) mg × (\d+) daily\s+([\d.]+) mg\/day/);
    const sr17 = srText.match(/SR-17\s+([\d.]+) mg × (\d+) daily\s+([\d.]+) mg\/day/);
    if (!sr17) throw new Error(`Could not parse rendered SR-17 step: ${srText}`);
    return {
      range,
      phase,
      sevenOhPerDose: sevenOh ? Number(sevenOh[1]) : null,
      sevenOhDoses: sevenOh ? Number(sevenOh[2]) : 0,
      sevenOhTotal: sevenOh ? Number(sevenOh[3]) : 0,
      srPerDose: Number(sr17[1]),
      srDoses: Number(sr17[2]),
      srTotal: Number(sr17[3]),
    };
  }));
}

async function readAdvancedSchedule(page: Page): Promise<AdvancedScheduleRow[]> {
  return page.locator('tr.sr-schedule-row').evaluateAll((rows) => rows.map((row) => {
    const read = (label: string) => row.querySelector<HTMLElement>(`[data-label="${label}"]`)?.innerText.replace(/\s+/g, ' ').trim() ?? '';
    return {
      day: read('Day'),
      phase: read('Phase'),
      sr17: read('SR-17'),
      source: read('7-OH'),
    };
  }));
}

async function chooseSelectOption(page: Page, label: string, option: string | RegExp): Promise<void> {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
}

interactionTest('[CALC-001] taper defaults and derived totals stay coherent', interactionEvidence('Select each substance and show the displayed default dose and derived daily total updating coherently.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium calculator audit.');
  await audit.goto(TAPER_PATH);

  const substanceDefaults = [
    { option: '7-OH', perDose: '15', frequency: '4', total: '60 mg', rows: 30 },
    { option: 'MGM-15 / MIT-A / DHM products', perDose: '10', frequency: '3', total: '30 mg', rows: 30 },
    { option: 'Pseudo (mitragynine pseudoindoxyl)', perDose: '7', frequency: '3', total: '21 mg', rows: 30 },
  ] as const;

  for (const expected of substanceDefaults) {
    await audit.step(`Verify ${expected.option} defaults`, 'The selected substance resets every dose factor and regenerates its documented schedule.', async () => {
      await chooseSelectOption(page, 'What are you tapering?', expected.option);
      await expect(page.getByLabel('What are you tapering?', { exact: true })).toContainText(expected.option);
      await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue(expected.perDose);
      await expect(page.getByLabel('Times per day', { exact: true })).toHaveValue(expected.frequency);
      await expect(page.getByText(expected.total, { exact: true }).first()).toBeVisible();
      await expect(page.locator('tr.schedule-data-row')).toHaveCount(expected.rows);
    });
  }

  await chooseSelectOption(page, 'What are you tapering?', '7-OH');

  await audit.step('Recalculate the daily total', 'Changing either factor immediately updates the displayed total.', async () => {
    await replaceNumber(page, 'Per-dose amount (mg)', '20');
    await replaceNumber(page, 'Times per day', '3');
    await expect(page.getByText('60 mg', { exact: true }).first()).toBeVisible();
    await replaceNumber(page, 'Times per day', '4');
    await expect(page.getByText('80 mg', { exact: true }).first()).toBeVisible();
  });

  audit.observe('derived total', await page.getByText(/Total daily:/).first().innerText(), '80 mg (20 × 4)');
  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-002] taper inputs reject unsafe or unusable boundaries', interactionEvidence('Enter blank, decimal, minimum, maximum, and malformed values and show visible safe handling.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium calculator audit.');
  await audit.goto(TAPER_PATH);

  await audit.step('Clear the starting dose', 'The schedule is replaced by explicit input guidance.', async () => {
    await page.getByLabel('Per-dose amount (mg)', { exact: true }).fill('');
    await page.getByLabel('Per-dose amount (mg)', { exact: true }).blur();
    await expect(page.getByText(/Enter a per-dose amount and times-per-day larger than the jump-off dose/i)).toBeVisible();
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(0);
  });

  await audit.step('Enter a malformed dose', 'Non-numeric text cannot survive in the numeric control or leave a stale schedule visible.', async () => {
    const dose = page.getByLabel('Per-dose amount (mg)', { exact: true });
    await dose.fill('not-a-number');
    await dose.blur();
    await expect(dose).toHaveValue('');
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(0);
    await expect(page.getByText(/Enter a per-dose amount and times-per-day larger than the jump-off dose/i)).toBeVisible();
  });

  await audit.step('Enter a decimal dose at the minimum frequency', 'A valid decimal medication amount and the minimum frequency produce exact arithmetic.', async () => {
    await replaceNumber(page, 'Per-dose amount (mg)', '12.5');
    await replaceNumber(page, 'Times per day', '1');
    await expect(page.getByRole('heading', { name: 'Schedule table' })).toBeVisible();
    await expect(page.getByText('12.5 mg', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/NaN|Infinity/)).toHaveCount(0);
  });

  await audit.step('Use the maximum allowed frequency', 'Twelve daily doses remain valid and the total is recalculated exactly.', async () => {
    const frequency = page.getByLabel('Times per day', { exact: true });
    await replaceNumber(page, 'Times per day', '12');
    expect(await frequency.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(true);
    await expect(page.getByText('150 mg', { exact: true }).first()).toBeVisible();
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
  });

  await audit.step('Reject an out-of-range frequency', 'An invalid frequency is visibly invalid and cannot leave a misleading generated plan on screen.', async () => {
    const frequency = page.getByLabel('Times per day', { exact: true });
    await frequency.fill('13');
    expect(await frequency.evaluate((element: HTMLInputElement) => element.validity.rangeOverflow)).toBe(true);
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(0);
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-003] custom taper generates the requested day-by-day schedule', interactionEvidence('Configure a custom taper and show the requested day-by-day schedule and jump-off being generated.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium calculator audit.');
  await audit.goto(TAPER_PATH);

  await audit.step('Choose a custom duration', 'Custom duration controls become available.', async () => {
    await page.getByLabel('Taper duration', { exact: true }).click();
    await page.getByRole('option', { name: 'Custom duration' }).click();
    await expect(page.getByLabel('Total duration', { exact: true })).toBeVisible();
  });

  await audit.step('Generate a ten-day plan', 'The schedule has exactly ten data days and reaches the 5 mg jump-off.', async () => {
    await replaceNumber(page, 'Total duration', '10');
    const golden: TaperScheduleRow[] = [
      { day: 1, perDose: 15, times: 4, total: 60 },
      { day: 2, perDose: 11.5, times: 4, total: 46 },
      { day: 3, perDose: 11.5, times: 3, total: 34.5 },
      { day: 4, perDose: 13, times: 2, total: 26 },
      { day: 5, perDose: 10, times: 2, total: 20 },
      { day: 6, perDose: 7.5, times: 2, total: 15 },
      { day: 7, perDose: 5.75, times: 2, total: 11.5 },
      { day: 8, perDose: 4.25, times: 2, total: 8.5 },
      { day: 9, perDose: 3.25, times: 2, total: 6.5 },
      { day: 10, perDose: 2.5, times: 2, total: 5 },
    ];
    expect(await readTaperSchedule(page)).toEqual(golden);
    await expect(page.locator('tr.schedule-total-row td').last()).toHaveText('233 mg');
  });

  audit.observe('schedule data rows', await page.locator('tr.schedule-data-row').count(), '10');
  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-004] taper chart and schedule remain contained on a phone', interactionEvidence('Change calculator inputs on a phone viewport and show chart and schedule output remaining contained.', 'candidate-mobile-chromium'), async ({ page, audit }, testInfo) => {
  const project = meta(testInfo);
  test.skip(project.environment !== 'candidate' || project.deviceClass !== 'mobile' || !testInfo.project.name.includes('chromium'), 'Candidate mobile Chromium audit.');
  await audit.goto(TAPER_PATH);

  await audit.step('Inspect responsive output', 'The page does not overflow; the table either fits or owns any horizontal scrolling.', async () => {
    expect(await pageHasHorizontalOverflow(page)).toBeLessThanOrEqual(1);
    const scroller = page.locator('.taper-schedule-scroll');
    const dimensions = await scroller.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(dimensions.scrollWidth).toBeGreaterThanOrEqual(dimensions.clientWidth);
    if (dimensions.scrollWidth > dimensions.clientWidth) {
      expect(dimensions.overflowX).toMatch(/auto|scroll/);
      await scroller.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
      expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    }
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-005] taper input state persists and reset deliberately clears it', interactionEvidence('Change calculator inputs, reload, and reset while showing persistence followed by deliberate clearing.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium calculator audit.');
  await audit.goto(TAPER_PATH);

  await audit.step('Save a changed dose by reloading', 'The calculator restores the changed value from browser storage.', async () => {
    await replaceNumber(page, 'Per-dose amount (mg)', '21.5');
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue('21.5');
  });

  await audit.step('Reset the calculator', 'All fields return to the documented 7-OH defaults and remain reset after reload.', async () => {
    await page.getByRole('button', { name: 'Reset form' }).click();
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue('15');
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue('15');
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-006] taper schedule copy and printable export contain the current plan', interactionEvidence('Activate schedule copy and printable export and show both outputs containing the current plan.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium export audit.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await audit.goto(TAPER_PATH);

  await audit.step('Copy the schedule', 'Clipboard text identifies the substance, starting dose, duration, and day-by-day plan.', async () => {
    await page.getByRole('button', { name: 'Copy schedule' }).click();
    await expect(page.getByRole('button', { name: 'Copied' }).first()).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('Taper schedule — 7-OH');
    expect(copied).toContain('Starting dose: 15 mg × 4/day = 60 mg/day');
    expect(copied).toContain('Day 30:');
    audit.observe('copied schedule length', copied.length, 'Detailed multi-line plan');
  });

  await audit.step('Open the printable plan', 'A same-origin print view opens with the current schedule and no app controls.', async () => {
    await page.evaluate(() => {
      const nativeOpen = window.open.bind(window);
      window.open = ((url?: string | URL, target?: string, features?: string) => {
        const popup = nativeOpen(url, target, features);
        if (popup) {
          Object.defineProperty(popup, 'print', {
            configurable: true,
            value: () => {
              popup.document.documentElement.dataset.auditPrintRequested = 'true';
            },
          });
        }
        return popup;
      }) as typeof window.open;
    });
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Save as PDF' }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState('load');
    await popup.waitForFunction(
      () => document.documentElement.dataset.auditPrintRequested === 'true',
      undefined,
      { timeout: 5_000 },
    );
    await expect(popup.getByRole('heading', { level: 1, name: 'Taper Schedule', exact: true })).toBeVisible();
    await expect(popup.locator('p.subtitle')).toHaveText(
      '7-OH · 15 mg × 4/day → jump-off at 5 mg over 30 days',
    );
    expect(
      await popup.evaluate(() => document.documentElement.dataset.auditPrintRequested),
      'The printable document must finish loading and request print before it is accepted as evidence',
    ).toBe('true');
    await audit.holdSecondaryPageOutcome(popup, 'printable taper plan');
    await popup.close();
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-007] SR-17 simple mode builds documented 7, 10, and 14-day plans', interactionEvidence('Choose each SR-17 simple protocol and show its phases, totals, and tablet supply being generated.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium calculator audit.');
  await audit.goto(SR17_PATH);

  await audit.step('Enter a routine', 'Four 50 mg 7-OH doses produce a daily total and a starting SR-17 schedule.', async () => {
    await replaceNumber(page, '7-OH dose each time', '50');
    await page.getByRole('group', { name: '7-OH doses per day' }).getByRole('button', { name: '4', exact: true }).click();
    await expect(page.getByText('200 mg total each day')).toBeVisible();
    await expect(page.getByText('Starting SR-17 schedule')).toBeVisible();
  });

  const goldenProtocols: Record<7 | 10 | 14, { rows: SimpleScheduleRow[]; totalMg: string; tablets: string; stopDay: string }> = {
    7: {
      rows: [
        { range: '1-1', phase: 'Reduce 7-OH', sevenOhPerDose: 25, sevenOhDoses: 4, sevenOhTotal: 100, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '2-2', phase: 'Reduce 7-OH', sevenOhPerDose: 12.5, sevenOhDoses: 4, sevenOhTotal: 50, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '3-3', phase: 'SR-17 only', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '4-4', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 3, srTotal: 112.5 },
        { range: '5-5', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 2, srTotal: 75 },
        { range: '6-6', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 1, srTotal: 37.5 },
        { range: '7-7', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 18.75, srDoses: 1, srTotal: 18.75 },
      ],
      totalMg: '693.75 mg', tablets: '14', stopDay: '7-OH stops on Day 3',
    },
    10: {
      rows: [
        { range: '1-1', phase: 'Reduce 7-OH', sevenOhPerDose: 50, sevenOhDoses: 4, sevenOhTotal: 200, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '2-2', phase: 'Reduce 7-OH', sevenOhPerDose: 25, sevenOhDoses: 4, sevenOhTotal: 100, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '3-3', phase: 'Reduce 7-OH', sevenOhPerDose: 12.5, sevenOhDoses: 4, sevenOhTotal: 50, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '4-4', phase: 'Reduce 7-OH', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '5-5', phase: 'SR-17 only', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '6-7', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 3, srTotal: 112.5 },
        { range: '8-8', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 2, srTotal: 75 },
        { range: '9-9', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 1, srTotal: 37.5 },
        { range: '10-10', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 18.75, srDoses: 1, srTotal: 18.75 },
      ],
      totalMg: '1106.25 mg', tablets: '23', stopDay: '7-OH stops on Day 4',
    },
    14: {
      rows: [
        { range: '1-1', phase: 'Reduce 7-OH', sevenOhPerDose: 50, sevenOhDoses: 4, sevenOhTotal: 200, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '2-2', phase: 'Reduce 7-OH', sevenOhPerDose: 25, sevenOhDoses: 4, sevenOhTotal: 100, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '3-3', phase: 'Reduce 7-OH', sevenOhPerDose: 12.5, sevenOhDoses: 4, sevenOhTotal: 50, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '4-4', phase: 'Reduce 7-OH', sevenOhPerDose: 6.25, sevenOhDoses: 4, sevenOhTotal: 25, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '5-5', phase: 'Reduce 7-OH', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '6-7', phase: 'SR-17 only', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 4, srTotal: 150 },
        { range: '8-9', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 3, srTotal: 112.5 },
        { range: '10-11', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 2, srTotal: 75 },
        { range: '12-13', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 37.5, srDoses: 1, srTotal: 37.5 },
        { range: '14-14', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 18.75, srDoses: 1, srTotal: 18.75 },
      ],
      totalMg: '1518.75 mg', tablets: '31', stopDay: '7-OH stops on Day 5',
    },
  };

  for (const days of [7, 10, 14] as const) {
    await audit.step(`Generate the ${days}-day simple plan`, `The plan ends on day ${days} and shows medication supply totals.`, async () => {
      await page.getByRole('radio', { name: `${days} days` }).check();
      await expect(page.getByText(`Your ${days}-day plan`)).toBeVisible();
      expect(await readSimpleSchedule(page)).toEqual(goldenProtocols[days].rows);
      await expect(page.getByText(goldenProtocols[days].stopDay, { exact: true })).toBeVisible();
      const totals = page.locator('dl').filter({ hasText: 'Total SR-17' });
      await expect(totals.locator('dd').nth(0)).toHaveText(goldenProtocols[days].totalMg);
      await expect(totals.locator('dd').nth(1)).toHaveText(goldenProtocols[days].tablets);
    });
  }

  await audit.attachJson('sr17-simple-golden-contract', {
    oracle: 'Hard-coded clinical-display vectors reviewed independently from the deployed calculator implementation.',
    routine: '50 mg 7-OH four times daily; 150 mg/day SR-17 target split into four 37.5 mg doses',
    protocols: goldenProtocols,
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-008] SR-17 advanced mode exposes and applies each schedule phase', interactionEvidence('Change every SR-17 advanced control and show allergy, preload, hold, reduction, and step-down responses.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium calculator audit.');
  await audit.goto(SR17_PATH);

  await audit.step('Switch to advanced mode', 'Allergy, preload, cross-taper, hold, and SR taper controls are visible.', async () => {
    await page.getByRole('group', { name: 'Calculator mode' }).getByRole('button', { name: 'Advanced' }).click();
    await expect(page.getByText(/Phase 1 · Preload/).first()).toBeVisible();
    await expect(page.getByLabel('Preload days', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Hold days', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Jump-off (mg)', { exact: true })).toBeVisible();
  });

  await audit.step('Build a custom milligram-cut protocol', 'Every configured phase produces the exact independently reviewed day-by-day schedule and total supply.', async () => {
    await replaceNumber(page, 'Current per-dose (mg)', '20');
    await replaceNumber(page, 'Times per day', '4');
    await replaceNumber(page, 'Preload days', '2');
    await replaceNumber(page, 'SR per dose (mg)', '40');
    await replaceNumber(page, 'Doses per day', '3');
    await chooseSelectOption(page, 'Mode', /Custom: even steps over N days/);
    await expect(page.getByLabel('Cross-taper days', { exact: true })).toBeVisible();
    await replaceNumber(page, 'Cross-taper days', '4');
    await replaceNumber(page, 'Hold days', '1');
    await chooseSelectOption(page, 'Taper mode', /Custom: cut N mg per day/);
    await replaceNumber(page, 'Cut per day (mg)', '30');
    await replaceNumber(page, 'Jump-off (mg)', '15');

    const golden: AdvancedScheduleRow[] = [
      { day: '0', phase: 'Allergy test', sr17: '10 mg × 1', source: '20 mg × 4 = 80 mg/day' },
      { day: '1', phase: 'Preload', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '20 mg × 4 = 80 mg/day' },
      { day: '2', phase: 'Preload', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '20 mg × 4 = 80 mg/day' },
      { day: '3', phase: 'Cross-taper', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '15 mg × 4 = 60 mg/day' },
      { day: '4', phase: 'Cross-taper', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '10 mg × 4 = 40 mg/day' },
      { day: '5', phase: 'Cross-taper', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '5 mg × 4 = 20 mg/day' },
      { day: '6', phase: 'Cross-taper', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '—' },
      { day: '7', phase: 'Hold', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '—' },
      { day: '8', phase: 'SR taper', sr17: '90 mg/day · 3 doses (~30 mg each)', source: '—' },
      { day: '9', phase: 'SR taper', sr17: '60 mg/day · 2 doses (~30 mg each)', source: '—' },
      { day: '10', phase: 'SR taper', sr17: '30 mg × 1', source: '—' },
      { day: '11', phase: 'Jump-off', sr17: '15 mg × 1', source: '—' },
      { day: '12', phase: 'Stop', sr17: '—', source: '—' },
    ];
    await expect(page.locator('tr.sr-schedule-row')).toHaveCount(golden.length);
    expect(await readAdvancedSchedule(page)).toEqual(golden);
    await expect(page.getByText('13 days', { exact: true })).toBeVisible();
    await expect(page.getByText('1045 mg', { exact: true })).toBeVisible();
    audit.observe('custom milligram golden rows', golden.length, '13 exact rows');
  });

  await audit.step('Exercise zero-day and percentage boundaries', 'Removing optional phases and jump-off yields the exact ten-day percentage schedule without a hidden frozen row.', async () => {
    await page.getByRole('checkbox', { name: /Include allergy-test day/i }).uncheck();
    await replaceNumber(page, 'Preload days', '1');
    await replaceNumber(page, 'Cross-taper days', '1');
    await replaceNumber(page, 'Hold days', '0');
    await chooseSelectOption(page, 'Taper mode', /Custom: cut N% per day/);
    await replaceNumber(page, 'Cut per day (%)', '50');
    await replaceNumber(page, 'Jump-off (mg)', '0');

    const boundaryGolden: AdvancedScheduleRow[] = [
      { day: '1', phase: 'Preload', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '20 mg × 4 = 80 mg/day' },
      { day: '2', phase: 'Cross-taper', sr17: '120 mg/day · 3 doses (~40 mg each)', source: '—' },
      { day: '3', phase: 'SR taper', sr17: '60 mg/day · 2 doses (~30 mg each)', source: '—' },
      { day: '4', phase: 'SR taper', sr17: '30 mg × 1', source: '—' },
      { day: '5', phase: 'SR taper', sr17: '15 mg × 1', source: '—' },
      { day: '6', phase: 'SR taper', sr17: '8 mg × 1', source: '—' },
      { day: '7', phase: 'SR taper', sr17: '4 mg × 1', source: '—' },
      { day: '8', phase: 'SR taper', sr17: '2 mg × 1', source: '—' },
      { day: '9', phase: 'SR taper', sr17: '1 mg × 1', source: '—' },
      { day: '10', phase: 'Stop', sr17: '—', source: '—' },
    ];
    await expect(page.locator('tr.sr-schedule-row')).toHaveCount(boundaryGolden.length);
    expect(await readAdvancedSchedule(page)).toEqual(boundaryGolden);
    await expect(page.getByText('10 days', { exact: true })).toBeVisible();
    await expect(page.getByText('360 mg', { exact: true })).toBeVisible();
    await expect(page.getByText('Jump-off', { exact: true })).toHaveCount(0);
    audit.observe('percentage boundary golden rows', boundaryGolden.length, '10 exact rows');
  });

  await audit.attachJson('sr17-advanced-golden-contract', {
    oracle: 'Hand-calculated from the published phase definitions; no calculator implementation code is imported.',
    cases: ['custom 30 mg cuts with explicit 15 mg jump-off', '50% cuts with allergy/hold/jump-off removed'],
    invariants: ['sequential day labels', 'exact phase boundaries', 'exact source totals', 'exact SR totals', 'exact duration', 'exact total supply'],
  });
  await audit.assertRuntimeHealthy();
});

staticTest('[CALC-009] taper arithmetic matches independent representative and boundary vectors', staticEvidence('Capture rendered black-box schedules together with independent representative, edge, and invariant assertions.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One deterministic candidate desktop arithmetic audit.');
  const assertArithmetic = (rows: TaperScheduleRow[]) => {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      expect(row.day).toBe(index + 1);
      expect(Number.isFinite(row.perDose)).toBe(true);
      expect(row.perDose).toBeGreaterThan(0);
      expect(row.times).toBeGreaterThanOrEqual(1);
      expect(row.total).toBeCloseTo(row.perDose * row.times, 6);
      if (index > 0) expect(row.total).toBeLessThanOrEqual(rows[index - 1]!.total);
    }
  };

  await audit.step('Verify the published buprenorphine table', 'The default 8 mg 14-day plan matches the independent established schedule exactly.', async () => {
    await audit.goto('/resources/suboxone-taper-calculator');
    const totals = [8, 8, 7, 6, 6, 5, 4, 4, 3, 2, 1.5, 1, 0.5, 0.25];
    const golden = totals.map((total, index) => ({ day: index + 1, perDose: total, times: 1, total }));
    const rows = await readTaperSchedule(page);
    expect(rows).toEqual(golden);
    assertArithmetic(rows);
    await expect(page.locator('tr.schedule-total-row td').last()).toHaveText('56.25 mg');
  });

  await audit.step('Verify a two-day 7-OH boundary', 'A two-day plan retains only the exact start and jump-off values with a correct supply sum.', async () => {
    await audit.goto(TAPER_PATH);
    await chooseSelectOption(page, 'Taper duration', 'Custom duration');
    await replaceNumber(page, 'Total duration', '2');
    const golden: TaperScheduleRow[] = [
      { day: 1, perDose: 15, times: 4, total: 60 },
      { day: 2, perDose: 2.5, times: 2, total: 5 },
    ];
    const rows = await readTaperSchedule(page);
    expect(rows).toEqual(golden);
    assertArithmetic(rows);
    await expect(page.locator('tr.schedule-total-row td').last()).toHaveText('65 mg');
  });

  await audit.step('Verify an explicit zero jump-off boundary', 'A pseudoindoxyl plan reaches its practical floor and appends one explicit zero-dose stop day.', async () => {
    await chooseSelectOption(page, 'What are you tapering?', 'Pseudo (mitragynine pseudoindoxyl)');
    await chooseSelectOption(page, 'Taper duration', 'Custom duration');
    await replaceNumber(page, 'Total duration', '2');
    await replaceNumber(page, 'Jump-off dose (mg)', '0');
    const golden: TaperScheduleRow[] = [
      { day: 1, perDose: 7, times: 3, total: 21 },
      { day: 2, perDose: 0.5, times: 1, total: 0.5 },
    ];
    const rows = await readTaperSchedule(page);
    expect(rows).toEqual(golden);
    assertArithmetic(rows);
    await expect(page.locator('tr.schedule-stop-row [data-label="Day"]')).toHaveText('3');
    await expect(page.locator('tr.schedule-stop-row')).toContainText('Stop. Taper complete.');
    await expect(page.locator('tr.schedule-total-row td').last()).toHaveText('21.5 mg');
    await expect(page.getByText('3 days', { exact: true }).first()).toBeVisible();
  });

  await audit.attachJson('calculator-invariants', {
    oracle: 'Independent black-box vectors; no site schedule generator is imported into the audit harness.',
    cases: ['published 8 mg buprenorphine 14-day table', 'two-day 7-OH start/jump boundary', 'pseudoindoxyl explicit-zero stop boundary'],
    invariantSet: ['sequential days', 'finite positive doses', 'per-dose × frequency = daily total', 'non-increasing total', 'supply sum'],
  });
  await audit.checkpoint('taper-arithmetic-reviewed-schedule');
  await audit.assertRuntimeHealthy();
});
