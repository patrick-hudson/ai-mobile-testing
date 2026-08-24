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

  await audit.step('Verify documented defaults', '15 mg taken four times produces 60 mg/day and a 30-day schedule.', async () => {
    await expect(page.getByLabel('Per-dose amount (mg)', { exact: true })).toHaveValue('15');
    await expect(page.getByLabel('Times per day', { exact: true })).toHaveValue('4');
    await expect(page.getByText('60 mg', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('30 days', { exact: true }).first()).toBeVisible();
  });

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
  });

  await audit.step('Enter a decimal dose', 'Valid decimal medication amounts generate a schedule without NaN or Infinity.', async () => {
    await replaceNumber(page, 'Per-dose amount (mg)', '12.5');
    await expect(page.getByRole('heading', { name: 'Schedule table' })).toBeVisible();
    await expect(page.getByText(/NaN|Infinity/)).toHaveCount(0);
  });

  await audit.step('Attempt an out-of-range frequency', 'Browser constraints expose the invalid value instead of silently presenting it as valid.', async () => {
    const frequency = page.getByLabel('Times per day', { exact: true });
    await frequency.fill('13');
    expect(await frequency.evaluate((element: HTMLInputElement) => element.validity.rangeOverflow)).toBe(true);
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
    const rows = page.locator('tr.schedule-data-row');
    await expect(rows).toHaveCount(10);
    await expect(rows.first().locator('[data-label="Total daily (mg)"]')).toHaveText('60');
    await expect(rows.last().locator('[data-label="Total daily (mg)"]')).toHaveText('5');
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

  for (const days of [7, 10, 14] as const) {
    await audit.step(`Generate the ${days}-day simple plan`, `The plan ends on day ${days} and shows medication supply totals.`, async () => {
      await page.getByRole('radio', { name: `${days} days` }).check();
      await expect(page.getByText(`Your ${days}-day plan`)).toBeVisible();
      await expect(page.getByText(`Stop SR-17 after the final dose on Day ${days}.`)).toHaveCount(0);
      const lastStep = page.locator('[data-simple-sr17-step]').last();
      const end = await lastStep.getAttribute('data-simple-sr17-step');
      expect(Number(end?.split('-')[1])).toBe(days);
      await expect(page.getByText('50 mg tablets needed')).toBeVisible();
    });
  }

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

staticTest('[CALC-009] taper arithmetic obeys monotonic and total-supply invariants', staticEvidence('Capture the rendered deterministic schedule together with monotonic-dose and total-supply assertions.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One deterministic candidate desktop arithmetic audit.');
  await audit.goto(TAPER_PATH);

  await audit.step('Read the generated schedule as structured values', 'Every row contains finite, positive dose arithmetic.', async () => {
    const rows = await page.locator('tr.schedule-data-row').evaluateAll((elements) => elements.map((row) => {
      const read = (label: string) => Number(row.querySelector<HTMLElement>(`[data-label="${label}"]`)?.innerText.trim());
      return {
        day: read('Day'),
        perDose: read('Per dose (mg)'),
        times: read('Times/day'),
        total: read('Total daily (mg)'),
      };
    }));
    expect(rows).toHaveLength(30);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      expect(row.day).toBe(index + 1);
      expect(Number.isFinite(row.perDose)).toBe(true);
      expect(row.perDose).toBeGreaterThan(0);
      expect(row.times).toBeGreaterThanOrEqual(1);
      expect(row.total).toBeCloseTo(row.perDose * row.times, 6);
      if (index > 0) expect(row.total).toBeLessThanOrEqual(rows[index - 1]!.total);
    }
    expect(rows[0]!.total).toBe(60);
    expect(rows.at(-1)!.total).toBe(5);

    const displayedSupply = Number((await page.locator('tr.schedule-total-row td').last().innerText()).match(/[\d.]+/)?.[0]);
    const computedSupply = rows.reduce((sum, row) => sum + row.total, 0);
    expect(displayedSupply).toBeCloseTo(computedSupply, 1);
    audit.observe('computed total medication', computedSupply, String(displayedSupply));
  });

  await audit.attachJson('calculator-invariants', {
    scheduleRows: await page.locator('tr.schedule-data-row').count(),
    invariantSet: ['sequential days', 'finite positive doses', 'per-dose × frequency = daily total', 'non-increasing total', 'supply sum'],
  });
  await audit.checkpoint('taper-arithmetic-reviewed-schedule');
  await audit.assertRuntimeHealthy();
});
