import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { evaluateDarkThemePaintContract, evaluateHeaderBreakpointContract } from '../audit/page-oracles.js';
import { REVIEWED_HEADER_BREAKPOINTS, REVIEWED_HEADER_CONTROLS, REVIEWED_HOME_LIVE_MEETING_INDEX } from '../audit/routes.js';
import { auditMeta, dismissSchedulingNotice, isChromiumAuditProject, matchesAuditTargetTemplate, pageHasHorizontalOverflow, usesReviewedSiteContract, waitForSettledUI } from './helpers.js';

staticTest('[SHELL-002] responsive header keeps its primary actions visible and operable', staticEvidence('Capture the responsive header across every custom breakpoint with visible-control and clipping geometry.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!matchesAuditTargetTemplate(testInfo, 'candidate-desktop-chromium'), 'One resizable Chromium target checks the complete responsive header contract.');
  const evidence = [];
  for (const contract of REVIEWED_HEADER_BREAKPOINTS) {
    await page.setViewportSize({ width: contract.width, height: 844 });
    await audit.goto('/');
    await dismissSchedulingNotice(page);
    await waitForSettledUI(page);
    const header = page.locator('header').first();
    const controls = await header.locator('a[href], button').evaluateAll((nodes) => nodes.flatMap((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (box.width <= 0 || box.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return [];
      const href = node instanceof HTMLAnchorElement ? node.getAttribute('href') : null;
      const accessibleName = (node.getAttribute('aria-label') ?? (node as HTMLElement).innerText).replace(/\s+/g, ' ').trim();
      let id: string;
      if (href === '/') id = 'home';
      else if (href === '/next-kratom-support-meeting') id = 'meeting';
      else if (href === 'https://discord.gg/quitting7oh') id = 'discord';
      else if (href === '/search') id = 'search';
      else if (href === '/start-here/7-oh-withdrawal-help') id = 'help';
      else if (accessibleName === 'Open guide navigation') id = 'guide';
      else if (accessibleName.startsWith('Appearance:')) id = 'appearance';
      else id = `unreviewed:${node.tagName.toLowerCase()}:${accessibleName}`;
      return [{ id, accessibleName, href, box: box.toJSON() }];
    }));
    const observed = { width: contract.width, controls };
    const issues = evaluateHeaderBreakpointContract(contract, REVIEWED_HEADER_CONTROLS, observed);
    evidence.push({ contract, observed, issues });
    expect(issues, `Header at ${contract.width}px must equal its reviewed inventory, destinations, geometry, and non-overlap contract`).toEqual([]);
  }
  expect(REVIEWED_HEADER_BREAKPOINTS, 'The responsive-header contract must retain all nine reviewed widths').toHaveLength(9);
  expect(evidence.map(({ observed }) => observed.width), 'Every declared header width must produce one inspected record')
    .toEqual(REVIEWED_HEADER_BREAKPOINTS.map(({ width }) => width));
  await audit.attachJson('responsive-header-ledger', evidence);
  audit.observe('Header breakpoints inspected', evidence.length, String(REVIEWED_HEADER_BREAKPOINTS.length));
  await audit.checkpoint('responsive-header-final');
});

interactionTest('[THEME-001] explicit light and dark modes persist', interactionEvidence('Choose light and dark appearance controls, reload, and show the selected mode applying and persisting.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  const project = auditMeta(testInfo);
  test.skip(!usesReviewedSiteContract(testInfo) || project.deviceClass !== 'desktop' || !isChromiumAuditProject(testInfo), 'Desktop reviewed-site theme control.');
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

staticTest('[THEME-004] custom breakpoints do not clip header actions', staticEvidence('Capture the final breakpoint state with the full breakpoint overflow, required-control, and overlap ledger.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!matchesAuditTargetTemplate(testInfo, 'candidate-desktop-chromium'), 'Single resizable Chromium target prevents redundant probes.');
  const widths = [320, 359, 360, 519, 520, 719, 720, 759, 760, 899, 900, 1023, 1024, 1279, 1280] as const;
  const observations: Array<{ width: number; overflowPx: number; overlap: boolean; requiredActions: string[] }> = [];

  for (const width of widths) {
    await audit.step(`Render header at ${width}px`, 'Visible header controls fit inside the viewport without overlap.', async () => {
      await page.setViewportSize({ width, height: 844 });
      await audit.goto('/');
      await dismissSchedulingNotice(page);
      await waitForSettledUI(page);
      const overflowPx = await pageHasHorizontalOverflow(page);
      expect(overflowPx, `Page overflow at ${width}px`).toBe(0);
      const header = page.locator('header').first();
      const requiredControls = [
        { id: 'home', locator: header.locator('a[aria-label="quitting7oh.org"]:visible') },
        { id: 'search', locator: header.getByRole('link', { name: 'Search the guide' }) },
        { id: 'urgent-help', locator: header.getByRole('link', { name: 'Help now', exact: true }) },
        ...(width < 1024
          ? [{ id: 'guide-navigation', locator: header.getByRole('button', { name: 'Open guide navigation' }) }]
          : []),
        ...(width >= 520
          ? [{ id: 'meetings', locator: header.locator('a[href="/next-kratom-support-meeting"]') }]
          : []),
        ...(width >= 720
          ? [{ id: 'appearance', locator: header.getByRole('button', { name: /^Appearance:/ }) }]
          : []),
        ...(width >= 760
          ? [{ id: 'discord', locator: header.locator('a[href="https://discord.gg/quitting7oh"]') }]
          : []),
      ];
      const requiredActions: string[] = [];
      for (const control of requiredControls) {
        await expect(control.locator, `${control.id} must remain visible at ${width}px`).toHaveCount(1);
        await expect(control.locator, `${control.id} must remain visible at ${width}px`).toBeVisible();
        const operability = await control.locator.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            disabled: element instanceof HTMLButtonElement && element.disabled,
            ariaDisabled: element.getAttribute('aria-disabled'),
            tabIndex: (element as HTMLElement).tabIndex,
            pointerEvents: style.pointerEvents,
            box: box.toJSON(),
          };
        });
        expect(operability.disabled, `${control.id} must remain enabled at ${width}px`).toBe(false);
        expect(operability.ariaDisabled, `${control.id} must not be aria-disabled at ${width}px`).not.toBe('true');
        expect(operability.tabIndex, `${control.id} must remain keyboard reachable at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(operability.pointerEvents, `${control.id} must remain pointer operable at ${width}px`).not.toBe('none');
        expect(operability.box.left, `${control.id} must not clip left at ${width}px`).toBeGreaterThanOrEqual(-1);
        expect(operability.box.right, `${control.id} must not clip right at ${width}px`).toBeLessThanOrEqual(width + 1);
        requiredActions.push(control.id);
      }

      const guideToggle = header.getByRole('button', { name: 'Open guide navigation' });
      const meetingLink = header.locator('a[href="/next-kratom-support-meeting"]');
      const appearanceButton = header.getByRole('button', { name: /^Appearance:/ });
      const discordLink = header.locator('a[href="https://discord.gg/quitting7oh"]');
      if (width < 1024) await expect(guideToggle, `Guide toggle must be visible below 1024px (${width}px)`).toBeVisible();
      else await expect(guideToggle, `Guide toggle must hand off to desktop navigation at 1024px (${width}px)`).toBeHidden();
      if (width >= 520) await expect(meetingLink, `Meeting action must be visible from 520px (${width}px)`).toBeVisible();
      else await expect(meetingLink, `Meeting action must remain intentionally hidden below 520px (${width}px)`).toBeHidden();
      if (width >= 720) await expect(appearanceButton, `Appearance action must be visible from 720px (${width}px)`).toBeVisible();
      else await expect(appearanceButton, `Appearance action must remain intentionally hidden below 720px (${width}px)`).toBeHidden();
      if (width >= 760) await expect(discordLink, `Discord action must be visible from 760px (${width}px)`).toBeVisible();
      else await expect(discordLink, `Discord action must remain intentionally hidden below 760px (${width}px)`).toBeHidden();

      const overlap = await header.evaluate((headerElement) => {
        const visible = [...headerElement.querySelectorAll<HTMLElement>('a,button')].filter((element) => {
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
      observations.push({ width, overflowPx, overlap, requiredActions });
      audit.observe(`horizontal overflow at ${width}px`, overflowPx, '0 px');
    });
  }
  expect(widths, 'The breakpoint-boundary contract must retain all fifteen reviewed widths').toHaveLength(15);
  expect(observations.map(({ width }) => width), 'Every declared breakpoint width must produce one geometry observation').toEqual([...widths]);
  expect(observations.every(({ overflowPx, overlap }) => overflowPx === 0 && !overlap), 'Every inspected breakpoint must remain overflow- and overlap-free').toBe(true);
  await audit.attachJson('breakpoint-control-ledger', observations);
  await audit.checkpoint('breakpoint-final-1280');
});

staticTest('[THEME-003] first paint honors stored dark mode', staticEvidence('Capture the first rendered dark state with its pre-hydration class, mode, and computed background.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!matchesAuditTargetTemplate(testInfo, 'candidate-desktop-chromium'), 'Reviewed-site first-paint audit.');
  await page.route('**/live-meeting-index.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(REVIEWED_HOME_LIVE_MEETING_INDEX),
  }));
  await page.addInitScript(() => {
    localStorage.setItem('theme', 'dark');
    const auditWindow = window as Window & {
      __auditDarkPaintProbe?: { frames: Array<{
        dark: boolean;
        mode: string | null;
        background: string | null;
        foreground: string | null;
        readyState: string;
        frameTimestamp: number;
      }> };
    };
    auditWindow.__auditDarkPaintProbe = { frames: [] };
    requestAnimationFrame((frameTimestamp) => {
      const body = document.body;
      const style = body ? getComputedStyle(body) : null;
      auditWindow.__auditDarkPaintProbe?.frames.push({
        dark: document.documentElement.classList.contains('dark'),
        mode: document.documentElement.dataset.themeMode ?? null,
        background: style?.backgroundColor ?? null,
        foreground: style?.color ?? null,
        readyState: document.readyState,
        frameTimestamp,
      });
    });
  });

  const readPaintEvidence = async () => {
    await expect.poll(() => page.evaluate(() => (
      window as Window & { __auditDarkPaintProbe?: { frames: unknown[] } }
    ).__auditDarkPaintProbe?.frames.length ?? 0), {
      message: 'The pre-paint probe must capture the first animation frame.',
    }).toBe(1);
    return page.evaluate(() => {
      const probe = (window as Window & {
        __auditDarkPaintProbe?: { frames: Array<{
          dark: boolean;
          mode: string | null;
          background: string | null;
          foreground: string | null;
          readyState: string;
          frameTimestamp: number;
        }> };
      }).__auditDarkPaintProbe;
      const firstFrame = probe?.frames[0] ?? null;
      const style = getComputedStyle(document.body);
      return {
        firstFrame,
        settled: {
          dark: document.documentElement.classList.contains('dark'),
          mode: document.documentElement.dataset.themeMode ?? null,
          background: style.backgroundColor,
          foreground: style.color,
          readyState: document.readyState,
        },
        stored: localStorage.getItem('theme'),
      };
    });
  };

  await audit.goto('/');
  const initial = await readPaintEvidence();
  expect(initial.firstFrame, 'The first pre-paint animation frame must be recorded').not.toBeNull();
  expect(evaluateDarkThemePaintContract(initial.firstFrame!), 'Stored dark mode must be visually dark and readable before the first paint').toEqual([]);
  expect(evaluateDarkThemePaintContract(initial.settled), 'Hydration must preserve the same visually dark and readable state').toEqual([]);
  expect(initial.stored).toBe('dark');
  audit.observe('first pre-paint dark state', JSON.stringify(initial.firstFrame), 'dark class, dark mode, dark surface, and readable contrast before first paint');
  await audit.checkpoint('first-paint-dark');

  await page.reload({ waitUntil: 'load' });
  const reloaded = await readPaintEvidence();
  expect(reloaded.firstFrame, 'The reload must record a new first pre-paint frame').not.toBeNull();
  expect(evaluateDarkThemePaintContract(reloaded.firstFrame!), 'Reloaded dark preference must apply before the first paint').toEqual([]);
  expect(evaluateDarkThemePaintContract(reloaded.settled), 'Reload hydration must retain visual contrast').toEqual([]);
  expect(reloaded.stored).toBe('dark');
  await audit.attachJson('first-paint-dark-contract', { initial, reloaded });
  await audit.checkpoint('first-paint-dark-reloaded');
  await audit.assertRuntimeHealthy();
});
