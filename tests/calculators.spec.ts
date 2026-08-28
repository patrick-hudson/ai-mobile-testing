import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { auditMeta, isChromiumAuditProject, pageHasHorizontalOverflow, usesReviewedSiteContract } from './helpers.js';
import type { Page } from '@playwright/test';

const TAPER_PATH = '/resources/7-oh-taper-calculator';
const BUPE_TAPER_PATH = '/resources/suboxone-taper-calculator';
const SR17_PATH = '/resources/sr-17-taper-calculator';

function currentSiteChromium(testInfo: Parameters<typeof auditMeta>[0]): boolean {
  return usesReviewedSiteContract(testInfo) && isChromiumAuditProject(testInfo);
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

interface ReviewedTaperPreset {
  label: '3 months' | '2 months' | '1 month' | '21 days';
  totalSupply: string;
  rows: string;
}

const REVIEWED_7OH_PRESETS: readonly ReviewedTaperPreset[] = [
  {
    label: '3 months',
    totalSupply: '2001.5 mg',
    rows: '1:15x4=60|2:14.5x4=58|3:14.25x4=57|4:13.75x4=55|5:13.5x4=54|6:13x4=52|7:12.75x4=51|8:12.25x4=49|9:12x4=48|10:11.75x4=47|11:11.25x4=45|12:14.75x3=44.25|13:14.25x3=42.75|14:14x3=42|15:13.5x3=40.5|16:13.25x3=39.75|17:12.75x3=38.25|18:12.5x3=37.5|19:12x3=36|20:11.75x3=35.25|21:11.5x3=34.5|22:11.25x3=33.75|23:10.75x3=32.25|24:10.5x3=31.5|25:10.25x3=30.75|26:15x2=30|27:14.5x2=29|28:14x2=28|29:13.75x2=27.5|30:13.25x2=26.5|31:13x2=26|32:12.5x2=25|33:12.25x2=24.5|34:12x2=24|35:11.5x2=23|36:11.25x2=22.5|37:11x2=22|38:10.75x2=21.5|39:10.5x2=21|40:10x2=20|41:9.75x2=19.5|42:9.5x2=19|43:9.25x2=18.5|44:9x2=18|45:8.75x2=17.5|46:8.5x2=17|47:8.25x2=16.5|48:8x2=16|49:7.75x2=15.5|50:7.75x2=15.5|51:7.5x2=15|52:7.25x2=14.5|53:7x2=14|54:6.75x2=13.5|55:6.75x2=13.5|56:6.5x2=13|57:6.25x2=12.5|58:6x2=12|59:6x2=12|60:5.75x2=11.5|61:5.5x2=11|62:5.5x2=11|63:5.25x2=10.5|64:5.25x2=10.5|65:5x2=10|66:5x2=10|67:4.75x2=9.5|68:4.5x2=9|69:4.5x2=9|70:4.25x2=8.5|71:4.25x2=8.5|72:4.25x2=8.5|73:4x2=8|74:4x2=8|75:3.75x2=7.5|76:3.75x2=7.5|77:3.5x2=7|78:3.5x2=7|79:3.5x2=7|80:3.25x2=6.5|81:3.25x2=6.5|82:3.25x2=6.5|83:3x2=6|84:3x2=6|85:2.75x2=5.5|86:2.75x2=5.5|87:2.75x2=5.5|88:2.75x2=5.5|89:2.5x2=5|90:2.5x2=5',
  },
  {
    label: '2 months',
    totalSupply: '1340.25 mg',
    rows: '1:15x4=60|2:14.5x4=58|3:13.75x4=55|4:13.25x4=53|5:12.75x4=51|6:12.25x4=49|7:11.75x4=47|8:15x3=45|9:14.25x3=42.75|10:13.75x3=41.25|11:13.25x3=39.75|12:12.5x3=37.5|13:12x3=36|14:11.5x3=34.5|15:11x3=33|16:10.75x3=32.25|17:10.25x3=30.75|18:14.75x2=29.5|19:14x2=28|20:13.5x2=27|21:13x2=26|22:12.5x2=25|23:12x2=24|24:11.5x2=23|25:11x2=22|26:10.5x2=21|27:10x2=20|28:9.5x2=19|29:9.25x2=18.5|30:8.75x2=17.5|31:8.5x2=17|32:8.25x2=16.5|33:7.75x2=15.5|34:7.5x2=15|35:7.25x2=14.5|36:6.75x2=13.5|37:6.5x2=13|38:6.25x2=12.5|39:6x2=12|40:5.75x2=11.5|41:5.5x2=11|42:5.25x2=10.5|43:5x2=10|44:5x2=10|45:4.75x2=9.5|46:4.5x2=9|47:4.25x2=8.5|48:4.25x2=8.5|49:4x2=8|50:3.75x2=7.5|51:3.75x2=7.5|52:3.5x2=7|53:3.25x2=6.5|54:3.25x2=6.5|55:3x2=6|56:3x2=6|57:2.75x2=5.5|58:2.75x2=5.5|59:2.5x2=5|60:2.5x2=5',
  },
  {
    label: '1 month',
    totalSupply: '674.75 mg',
    rows: '1:15x4=60|2:13.75x4=55|3:12.75x4=51|4:11.5x4=46|5:14.25x3=42.75|6:13x3=39|7:12x3=36|8:11x3=33|9:10x3=30|10:13.75x2=27.5|11:12.75x2=25.5|12:11.75x2=23.5|13:10.75x2=21.5|14:9.75x2=19.5|15:9x2=18|16:8.25x2=16.5|17:7.5x2=15|18:7x2=14|19:6.5x2=13|20:6x2=12|21:5.5x2=11|22:5x2=10|23:4.5x2=9|24:4.25x2=8.5|25:3.75x2=7.5|26:3.5x2=7|27:3.25x2=6.5|28:3x2=6|29:2.75x2=5.5|30:2.5x2=5',
  },
  {
    label: '21 days',
    totalSupply: '476.25 mg',
    rows: '1:15x4=60|2:13.25x4=53|3:11.75x4=47|4:13.75x3=41.25|5:12.25x3=36.75|6:10.75x3=32.25|7:14.25x2=28.5|8:12.5x2=25|9:11x2=22|10:9.75x2=19.5|11:8.75x2=17.5|12:7.75x2=15.5|13:6.75x2=13.5|14:6x2=12|15:5.25x2=10.5|16:4.75x2=9.5|17:4x2=8|18:3.75x2=7.5|19:3.25x2=6.5|20:2.75x2=5.5|21:2.5x2=5',
  },
] as const;

function parseReviewedTaperRows(encoded: string): TaperScheduleRow[] {
  return encoded.split('|').map((entry) => {
    const match = entry.match(/^(\d+):([\d.]+)x(\d+)=([\d.]+)$/);
    if (!match) throw new Error(`Invalid reviewed taper row: ${entry}`);
    return { day: Number(match[1]), perDose: Number(match[2]), times: Number(match[3]), total: Number(match[4]) };
  });
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
    const readColumn = (column: Element | undefined) => [...(column?.querySelectorAll('p') ?? [])]
      .map((paragraph) => (paragraph as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    const sevenOhText = readColumn(columns[0]);
    const srText = readColumn(columns[1]);
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
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium calculator audit.');
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
      await expect(page.getByText('Total daily:', { exact: true }).locator('..')).toHaveText(
        `Total daily: ${expected.total} (${expected.perDose} × ${expected.frequency})`,
      );
      await expect(page.locator('tr.schedule-data-row')).toHaveCount(expected.rows);
    });
  }

  await chooseSelectOption(page, 'What are you tapering?', '7-OH');

  await audit.step('Recalculate the daily total', 'Changing either factor immediately updates the displayed total.', async () => {
    await replaceNumber(page, 'Per-dose amount (mg)', '20');
    await replaceNumber(page, 'Times per day', '3');
    await expect(page.getByText('Total daily:', { exact: true }).locator('..')).toHaveText('Total daily: 60 mg (20 × 3)');
    await replaceNumber(page, 'Times per day', '4');
    await expect(page.getByText('Total daily:', { exact: true }).locator('..')).toHaveText('Total daily: 80 mg (20 × 4)');
  });

  audit.observe('derived total', await page.getByText('Total daily:', { exact: true }).locator('..').innerText(), 'Total daily: 80 mg (20 × 4)');
  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-002] taper inputs safely preserve, reject, or clamp boundary drafts', interactionEvidence('Enter blank, malformed, zero, decimal, minimum, maximum, and overflowing values and show the exact safe response.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium calculator audit.');
  await audit.goto(TAPER_PATH);
  const totalDaily = page.getByText('Total daily:', { exact: true }).locator('..');

  await audit.step('Clear and leave the starting dose', 'A temporary blank preserves the last usable schedule and blur restores the committed value.', async () => {
    const dose = page.getByLabel('Per-dose amount (mg)', { exact: true });
    await dose.fill('');
    await expect(dose).toHaveValue('');
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
    await dose.blur();
    await expect(dose).toHaveValue('15');
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
  });

  await audit.step('Enter a transient malformed numeric draft', 'A keyboard-only incomplete number cannot replace the committed value or corrupt the usable schedule.', async () => {
    const dose = page.getByLabel('Per-dose amount (mg)', { exact: true });
    await dose.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.insertText('-');
    const malformedState = await dose.evaluate((element: HTMLInputElement) => ({
      value: element.value,
      badInput: element.validity.badInput,
      valid: element.checkValidity(),
    }));
    await audit.attachJson('malformed-native-number-state', malformedState);
    expect(malformedState).toEqual({ value: '', badInput: true, valid: false });
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
    await dose.blur();
    await expect(dose).toHaveValue('15');
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
  });

  await audit.step('Commit an explicit zero dose', 'A committed zero removes the obsolete plan and displays explicit guidance.', async () => {
    await replaceNumber(page, 'Per-dose amount (mg)', '0');
    await expect(page.getByText(/Enter a per-dose amount and times-per-day larger than the jump-off dose/i)).toBeVisible();
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(0);
  });

  await audit.step('Enter a decimal dose at the minimum frequency', 'A valid decimal medication amount and the minimum frequency produce exact arithmetic.', async () => {
    await replaceNumber(page, 'Per-dose amount (mg)', '12.5');
    await replaceNumber(page, 'Times per day', '1');
    await expect(page.getByRole('heading', { name: 'Schedule table' })).toBeVisible();
    await expect(totalDaily).toHaveText('Total daily: 12.5 mg (12.5 × 1)');
    expect((await readTaperSchedule(page))[0]).toEqual({ day: 1, perDose: 12.5, times: 1, total: 12.5 });
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
    await expect(page.getByText(/NaN|Infinity/)).toHaveCount(0);
  });

  await audit.step('Use the maximum allowed frequency', 'Twelve daily doses remain valid and the total is recalculated exactly.', async () => {
    const frequency = page.getByLabel('Times per day', { exact: true });
    await replaceNumber(page, 'Times per day', '12');
    expect(await frequency.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(true);
    await expect(totalDaily).toHaveText('Total daily: 150 mg (12.5 × 12)');
    expect((await readTaperSchedule(page))[0]).toEqual({ day: 1, perDose: 12.5, times: 12, total: 150 });
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
  });

  await audit.step('Clamp an out-of-range frequency', 'The transient overflow is natively invalid, the schedule uses the safe maximum, and blur visibly restores that maximum.', async () => {
    const frequency = page.getByLabel('Times per day', { exact: true });
    await frequency.fill('13');
    expect(await frequency.evaluate((element: HTMLInputElement) => element.validity.rangeOverflow)).toBe(true);
    await expect(totalDaily).toHaveText('Total daily: 150 mg (12.5 × 12)');
    expect((await readTaperSchedule(page))[0]).toEqual({ day: 1, perDose: 12.5, times: 12, total: 150 });
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
    await frequency.blur();
    await expect(frequency).toHaveValue('12');
    expect(await frequency.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(true);
    await expect(totalDaily).toHaveText('Total daily: 150 mg (12.5 × 12)');
    expect((await readTaperSchedule(page))[0]).toEqual({ day: 1, perDose: 12.5, times: 12, total: 150 });
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-003] custom taper generates the requested day-by-day schedule', interactionEvidence('Configure a custom taper and show the requested day-by-day schedule and jump-off being generated.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium calculator audit.');
  await audit.goto(TAPER_PATH);

  for (const preset of REVIEWED_7OH_PRESETS) {
    await audit.step(`Verify the ${preset.label} preset`, `Every rendered row and the total supply match the independent reviewed ${preset.label} vector.`, async () => {
      await chooseSelectOption(page, 'Taper duration', preset.label);
      const golden = parseReviewedTaperRows(preset.rows);
      expect(await readTaperSchedule(page), `${preset.label} must match every reviewed day, dose, frequency, and daily total`).toEqual(golden);
      await expect(page.locator('tr.schedule-total-row td').last()).toHaveText(preset.totalSupply);
    });
  }

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
  const project = auditMeta(testInfo);
  test.skip(!usesReviewedSiteContract(testInfo) || project.deviceClass !== 'mobile' || !isChromiumAuditProject(testInfo), 'Reviewed-site mobile Chromium audit.');
  await audit.goto(TAPER_PATH);

  await audit.step('Inspect the exact chart, summary, and table matrix', 'The chart has usable geometry, all three summaries retain reviewed values, and only the table owns horizontal scrolling.', async () => {
    expect(await pageHasHorizontalOverflow(page), 'The document itself must not overflow horizontally').toBe(0);
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const chartCard = page.getByRole('heading', { level: 2, name: 'Schedule curve (total daily)', exact: true }).locator('..');
    const chart = chartCard.locator('svg.recharts-surface');
    await expect(chart).toBeVisible();
    const chartGeometry = await chart.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    });
    expect(chartGeometry.width).toBeGreaterThan(250);
    expect(chartGeometry.height).toBeGreaterThan(200);
    expect(chartGeometry.left).toBeGreaterThanOrEqual(0);
    expect(chartGeometry.right).toBeLessThanOrEqual(viewport!.width);

    const summaryGrid = page.getByText('Total duration', { exact: true }).locator('..').locator('..');
    await expect(summaryGrid).toContainText('Approach');
    const summary = async (label: string, value: string) => {
      const card = summaryGrid.getByText(label, { exact: true }).locator('..');
      await expect(card).toHaveText(`${label}${value}`);
      const box = await card.boundingBox();
      expect(box, `${label} summary must have rendered geometry`).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
    };
    await summary('Total duration', '30 days');
    await summary('Total medication', '674.75 mg');
    await summary('Approach', 'Percentage taper');

    const rows = await readTaperSchedule(page);
    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual({ day: 1, perDose: 15, times: 4, total: 60 });
    expect(rows.at(-1)).toEqual({ day: 30, perDose: 2.5, times: 2, total: 5 });
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

  await audit.step('Operate the per-dose hint as a touch control', 'The mobile project reports a coarse pointer and tapping the exact Day 1 dose reveals its tablet equivalent without overflow.', async () => {
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches), 'The touch-hint contract must execute under touch media features').toBe(true);
    await replaceNumber(page, 'Tablet size (mg per tablet)', '15');
    const hint = page.getByRole('button', { name: '15 mg — show tablet count', exact: true }).first();
    await expect(hint).toBeVisible();
    await hint.click();
    await expect(page.getByText('1 tablet = 15 mg (15 mg per tablet)', { exact: true })).toBeVisible();
    expect(await pageHasHorizontalOverflow(page), 'Opening the touch hint must not create page-level overflow').toBe(0);
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-005] taper input state persists and reset deliberately clears it', interactionEvidence('Change calculator inputs, reload, and reset while showing persistence followed by deliberate clearing.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium calculator audit.');
  await audit.goto(TAPER_PATH);

  const expectedSavedState = {
    v: 1,
    substance: 'pseudo',
    perDose: 8.5,
    dosesPerDay: 5,
    jumpOff: 2,
    tabletSize: 4,
    difficulty: 'custom',
    customDays: 17,
  } as const;

  await audit.step('Persist the complete 7-OH-family form', 'Substance, dose, frequency, jump-off, tablet size, custom mode, duration, and exact schedule all survive reload.', async () => {
    await chooseSelectOption(page, 'What are you tapering?', 'Pseudo (mitragynine pseudoindoxyl)');
    await replaceNumber(page, 'Per-dose amount (mg)', String(expectedSavedState.perDose));
    await replaceNumber(page, 'Times per day', String(expectedSavedState.dosesPerDay));
    await replaceNumber(page, 'Tablet size (mg per tablet)', String(expectedSavedState.tabletSize));
    await replaceNumber(page, 'Jump-off dose (mg)', String(expectedSavedState.jumpOff));
    await chooseSelectOption(page, 'Taper duration', 'Custom duration');
    await replaceNumber(page, 'Total duration', String(expectedSavedState.customDays));
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(expectedSavedState.customDays);
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByLabel('What are you tapering?', { exact: true })).toContainText('Pseudo (mitragynine pseudoindoxyl)');
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue(String(expectedSavedState.perDose));
    await expect(page.getByLabel('Times per day', { exact: true })).toHaveValue(String(expectedSavedState.dosesPerDay));
    await expect(page.getByLabel('Tablet size (mg per tablet)', { exact: true })).toHaveValue(String(expectedSavedState.tabletSize));
    await expect(page.getByLabel('Jump-off dose (mg)', { exact: true })).toHaveValue(String(expectedSavedState.jumpOff));
    await expect(page.getByLabel('Taper duration', { exact: true })).toContainText('Custom duration');
    await expect(page.getByLabel('Total duration', { exact: true })).toHaveValue(String(expectedSavedState.customDays));
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(expectedSavedState.customDays);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('taper-calculator-v1-7oh-syn') ?? 'null'))).toEqual(expectedSavedState);
  });

  await audit.step('Prove calculator storage is isolated by tool', 'Changing the buprenorphine calculator neither inherits nor overwrites the complete 7-OH-family state.', async () => {
    await audit.goto(BUPE_TAPER_PATH);
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue('8');
    await expect(page.getByLabel('Times per day', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('Jump-off dose (mg)', { exact: true })).toHaveValue('0.25');
    await replaceNumber(page, 'Per-dose amount (mg)', '6');
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue('6');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('taper-calculator-v1-7oh-syn') ?? 'null'))).toEqual(expectedSavedState);
    await audit.goto(TAPER_PATH);
    await expect(page.getByLabel('What are you tapering?', { exact: true })).toContainText('Pseudo (mitragynine pseudoindoxyl)');
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue(String(expectedSavedState.perDose));
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(expectedSavedState.customDays);
  });

  await audit.step('Reset the complete calculator state', 'Every field, derived total, and schedule returns to documented 7-OH defaults and remains reset after reload.', async () => {
    await page.getByRole('button', { name: 'Reset form' }).click();
    await expect(page.getByLabel('What are you tapering?', { exact: true })).toContainText('7-OH');
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue('15');
    await expect(page.getByLabel('Times per day', { exact: true })).toHaveValue('4');
    await expect(page.getByLabel('Tablet size (mg per tablet)', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Jump-off dose (mg)', { exact: true })).toHaveValue('5');
    await expect(page.getByLabel('Taper duration', { exact: true })).toContainText('1 month');
    await expect(page.getByText('Total daily:', { exact: true }).locator('..')).toHaveText('Total daily: 60 mg (15 × 4)');
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByLabel('What are you tapering?', { exact: true })).toContainText('7-OH');
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue('15');
    await expect(page.getByLabel('Times per day', { exact: true })).toHaveValue('4');
    await expect(page.getByLabel('Jump-off dose (mg)', { exact: true })).toHaveValue('5');
    await expect(page.getByLabel('Taper duration', { exact: true })).toContainText('1 month');
    await expect(page.locator('tr.schedule-data-row')).toHaveCount(30);
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-006] taper schedule copy and printable export contain the current plan', interactionEvidence('Activate schedule copy and printable export and show both outputs containing the current plan.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium export audit.');
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

  await audit.step('Copy the AI personalization prompt', 'The second copy action confirms independently and includes the exact plan plus context, safety, and clinician scaffolding.', async () => {
    await page.getByRole('button', { name: 'Copy AI prompt' }).click();
    await expect(page.getByRole('button', { name: 'Copied' }).first()).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("I'm tapering off 7-OH and want help personalizing my plan.");
    expect(copied).toContain('- Starting dose: 15 mg × 4/day = 60 mg/day');
    expect(copied).toContain('- Duration: 30 days');
    expect(copied).toContain('Day 30: 2.5 mg × 2/day = 5 mg/day (jump-off)');
    expect(copied).toContain('CONTEXT — please ask me about these before suggesting changes:');
    expect(copied).toContain('When to bring in a clinician');
    expect(copied).toContain("Don't replace a prescriber; help me think through what to ask one");
    audit.observe('copied AI prompt length', copied.length, 'Complete plan, context questions, and safety framing');
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

  await audit.step('Fall back when the print popup is blocked', 'A null window.open result invokes current-page printing exactly once without waiting for a nonexistent popup.', async () => {
    await page.evaluate(() => {
      document.documentElement.dataset.auditFallbackPrintCount = '0';
      window.open = (() => null) as typeof window.open;
      window.print = () => {
        const current = Number(document.documentElement.dataset.auditFallbackPrintCount ?? '0');
        document.documentElement.dataset.auditFallbackPrintCount = String(current + 1);
      };
    });
    await page.getByRole('button', { name: 'Save as PDF' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.auditFallbackPrintCount)).toBe('1');
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-007] SR-17 simple mode builds documented 7, 10, and 14-day plans', interactionEvidence('Choose each SR-17 simple protocol and show its phases, totals, and tablet supply being generated.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium calculator audit.');
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
        { range: '7-7', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 25, srDoses: 1, srTotal: 25 },
      ],
      totalMg: '700 mg', tablets: '14', stopDay: '7-OH stops on Day 3',
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
        { range: '10-10', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 25, srDoses: 1, srTotal: 25 },
      ],
      totalMg: '1112.5 mg', tablets: '23', stopDay: '7-OH stops on Day 4',
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
        { range: '14-14', phase: 'Reduce SR-17', sevenOhPerDose: null, sevenOhDoses: 0, sevenOhTotal: 0, srPerDose: 25, srDoses: 1, srTotal: 25 },
      ],
      totalMg: '1525 mg', tablets: '31', stopDay: '7-OH stops on Day 5',
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
    oracle: 'Hard-coded display vectors follow the published nearest-quarter-tablet rule and an explicit product-policy assumption that exact half-quarter ties round upward. Clinical ownership must confirm that tie policy.',
    routine: '50 mg 7-OH four times daily; 150 mg/day SR-17 target split into four 37.5 mg doses',
    protocols: goldenProtocols,
  });
  audit.observe('SR-17 half-quarter tie policy', '18.75 mg displays as 25 mg', 'Clinical-owner confirmation required: exact ties round upward');
  audit.finding({
    severity: 'P0',
    title: 'SR-17 half-quarter tie policy is not clinically approved',
    detail: 'The rendered schedules consistently round an exact 18.75 mg half-quarter tie upward to 25 mg, but clinical ownership has not approved that product rule. CALC-007 must remain release-blocking until the rule is approved or corrected and this finding is deliberately removed.',
    blocking: true,
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[CALC-008] SR-17 advanced mode exposes and applies each schedule phase', interactionEvidence('Change every SR-17 advanced control and show allergy, preload, hold, reduction, and step-down responses.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium calculator audit.');
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
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One deterministic reviewed-site desktop arithmetic audit.');
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
