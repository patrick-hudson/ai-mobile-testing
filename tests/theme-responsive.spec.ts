import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { meta, dismissSchedulingNotice, pageHasHorizontalOverflow, waitForSettledUI } from './helpers.js';

staticTest('[SHELL-002] responsive header keeps its primary actions visible and operable', staticEvidence('Capture the responsive header across every custom breakpoint with visible-control and clipping geometry.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(testInfo.project.name !== 'candidate-desktop-chromium', 'One resizable Chromium project checks the complete responsive header contract.');
  const widths = [320, 360, 520, 719, 720, 760, 900, 1024, 1440] as const;
  const evidence = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await audit.goto('/');
    await dismissSchedulingNotice(page);
    const header = page.locator('header').first();
    const visibleActions = await header.locator('a[href], button').evaluateAll((nodes) => nodes.filter((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).map((node) => ({
      label: node.getAttribute('aria-label') ?? node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      href: node instanceof HTMLAnchorElement ? node.getAttribute('href') : null,
      box: node.getBoundingClientRect().toJSON(),
    })));
    const clipped = visibleActions.filter(({ box }) => box.left < -1 || box.right > width + 1 || box.top < -1);
    expect(clipped, `Visible header actions must fit at ${width}px`).toEqual([]);
    expect(visibleActions.some(({ href }) => href === '/start-here/7-oh-withdrawal-help'), `Help now must remain visible at ${width}px`).toBe(true);
    expect(visibleActions.some(({ label }) => /search/i.test(label)), `Search must remain visible at ${width}px`).toBe(true);
    if (width < 1024) expect(visibleActions.some(({ label }) => /open guide navigation/i.test(label))).toBe(true);
    if (width >= 520) expect(visibleActions.some(({ href }) => href === '/next-kratom-support-meeting')).toBe(true);
    evidence.push({ width, visibleActions, clipped });
  }
  expect(widths, 'The responsive-header contract must retain all nine reviewed widths').toHaveLength(9);
  expect(evidence.map(({ width }) => width), 'Every declared header width must produce one inspected record').toEqual([...widths]);
  await audit.attachJson('responsive-header-ledger', evidence);
  audit.observe('Header breakpoints inspected', widths.length, String(widths.length));
  await audit.checkpoint('responsive-header-final');
});

interactionTest('[THEME-001] explicit light and dark modes persist', interactionEvidence('Choose light and dark appearance controls, reload, and show the selected mode applying and persisting.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  const project = meta(testInfo);
  test.skip(project.environment !== 'candidate' || project.deviceClass !== 'desktop' || !testInfo.project.name.includes('chromium'), 'Desktop candidate theme control.');
  await audit.goto('/');
  const trigger = page.getByRole('button', { name: /appearance:/i });

  await audit.step('Choose light mode', 'The document becomes light and stores the explicit preference.', async () => {
    await trigger.click();
    await page.getByRole('menuitemradio', { name: /light/i }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
  });

  await audit.step('Choose dark mode and reload', 'Dark mode applies and survives navigation.', async () => {
    await trigger.click();
    await page.getByRole('menuitemradio', { name: /dark/i }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload({ waitUntil: 'load' });
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
  await audit.assertRuntimeHealthy();
});

staticTest('[THEME-004] custom breakpoints do not clip header actions', staticEvidence('Capture the final breakpoint state with the full breakpoint overflow and overlap ledger.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(testInfo.project.name !== 'candidate-desktop-chromium', 'Single resizable Chromium project prevents redundant probes.');
  const widths = [320, 359, 360, 519, 520, 719, 720, 759, 760, 899, 900, 1023, 1024, 1279, 1280] as const;
  const observations: Array<{ width: number; overflowPx: number; overlap: boolean }> = [];

  for (const width of widths) {
    await audit.step(`Render header at ${width}px`, 'Visible header controls fit inside the viewport without overlap.', async () => {
      await page.setViewportSize({ width, height: 844 });
      await audit.goto('/');
      await dismissSchedulingNotice(page);
      await waitForSettledUI(page);
      const overflowPx = await pageHasHorizontalOverflow(page);
      expect(overflowPx, `Page overflow at ${width}px`).toBe(0);
      const overlap = await page.locator('header').evaluate((header) => {
        const visible = [...header.querySelectorAll<HTMLElement>('a,button')].filter((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
        });
        return visible.some((left, index) => visible.slice(index + 1).some((right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          return x > 2 && y > 2;
        }));
      });
      expect(overlap, `Header overlap at ${width}px`).toBe(false);
      observations.push({ width, overflowPx, overlap });
      audit.observe(`horizontal overflow at ${width}px`, overflowPx, '0 px');
    });
  }
  expect(widths, 'The breakpoint-boundary contract must retain all fifteen reviewed widths').toHaveLength(15);
  expect(observations.map(({ width }) => width), 'Every declared breakpoint width must produce one geometry observation').toEqual([...widths]);
  expect(observations.every(({ overflowPx, overlap }) => overflowPx === 0 && !overlap), 'Every inspected breakpoint must remain overflow- and overlap-free').toBe(true);
  await audit.checkpoint('breakpoint-final-1280');
});

staticTest('[THEME-003] first paint honors stored dark mode', staticEvidence('Capture the first rendered dark state with its pre-hydration class, mode, and computed background.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(testInfo.project.name !== 'candidate-desktop-chromium', 'Candidate first-paint audit.');
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  await audit.goto('/');
  const state = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    mode: document.documentElement.dataset.themeMode,
    background: getComputedStyle(document.body).backgroundColor,
  }));
  audit.observe('first loaded theme state', JSON.stringify(state), 'dark class and dark mode before hydration');
  expect(state.dark).toBe(true);
  expect(state.mode).toBe('dark');
  await audit.checkpoint('first-paint-dark');
});
