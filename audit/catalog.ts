import type {
  AuditArea,
  AuditDefinition,
  AuditSeverity,
  AuditSingleSiteClassification,
} from './types.js';
import { createEvidencePolicy, evidenceKindsForPolicy } from './evidence-policy.js';

const INTERACTION_VIDEO_RATIONALES = new Map<string, string>([
  ['SHELL-001', 'Dismiss the scheduling notice, reload, and show that the notice remains dismissed.'],
  ['SHELL-003', 'Move keyboard focus to the skip link, activate it, and show the main fragment becoming the next sequential-focus entry point.'],
  ['SHELL-005', 'Scroll a long page, activate Back to top, and show the viewport returning to the beginning.'],
  ['NAV-001', 'Open, operate, and close the mobile guide drawer while showing focus and scroll restoration.'],
  ['NAV-002', 'Expand and collapse mobile guide categories and show their links and current-page state responding.'],
  ['NAV-003', 'Collapse, reload, and expand the desktop sidebar while showing persistence and stable reading position.'],
  ['NAV-004', 'Activate breadcrumb sharing and show the canonical page URL copied to the clipboard.'],
  ['NAV-005', 'Activate a table-of-contents link and show hash, heading alignment, and active reading position.'],
  ['NAV-006', 'Activate a heading permalink and show its hash, clipboard confirmation, and stable scroll position.'],
  ['NAV-007', 'Activate previous and next reading controls and show both intended guide destinations loading.'],
  ['THEME-001', 'Choose light and dark modes and show the selected appearance applying and persisting.'],
  ['THEME-002', 'Choose system appearance, change the emulated system scheme, and show the page following it.'],
  ['SEARCH-001', 'Open and close search with pointer and keyboard controls and show predictable focus movement.'],
  ['SEARCH-002', 'Enter a known query and show relevant search results and excerpts responding.'],
  ['SEARCH-003', 'Use keyboard result navigation and show Enter opening the active destination.'],
  ['SEARCH-004', 'Apply search filters and show the result set and URL state updating together.'],
  ['SEARCH-005', 'Enter one absent token, verify the no-result state, then replace it with a known treatment and use the recovered results.'],
  ['SEARCH-006', 'Enter a search while its index request fails and show the usable sitemap fallback.'],
  ['ENV-007', 'Open an unknown URL, use its accessible search, and activate a known recovery destination.'],
  ['HOME-001', 'Activate a primary homepage starting path and show the intended guide destination loading.'],
  ['CONTENT-007', 'Scroll progressively through long references and show that reading and navigation remain responsive.'],
  ['CALC-001', 'Select calculator inputs and show derived dose totals updating coherently.'],
  ['CALC-002', 'Enter boundary and malformed calculator drafts and show exact preserve, reject, restore, and clamp responses.'],
  ['CALC-003', 'Configure a custom taper and show the generated day-by-day schedule responding.'],
  ['CALC-004', 'Change calculator inputs at a mobile viewport and show responsive output remaining usable.'],
  ['CALC-005', 'Change, reload, and reset calculator inputs and show persistence followed by deliberate clearing.'],
  ['CALC-006', 'Use calculator copy and print actions and show the exported plan and confirmations.'],
  ['CALC-007', 'Choose SR-17 simple protocol controls and show each documented schedule being generated.'],
  ['CALC-008', 'Change SR-17 advanced controls and show each cross-taper phase updating.'],
  ['SOWS-001', 'Answer all withdrawal items and show the visible total updating after each choice.'],
  ['SOWS-002', 'Change SOWS answers across thresholds and show the interpretation responding.'],
  ['SOWS-003', 'Copy, collapse, reopen, and reset a SOWS score and show each state transition.'],
  ['SHARE-001', 'Activate the quickstart copy action and show clipboard contents and visible confirmation.'],
  ['MEET-003', 'Join a meeting, navigate to history, and clear it while showing persistence and removal.'],
  ['MEET-004', 'Combine and clear NA meeting filters and show empty and restored result states.'],
  ['MEET-005', 'Combine and clear SMART meeting filters and show empty and restored result states.'],
  ['MEET-006', 'Activate meeting copy and join controls and show clipboard data matching the displayed destination.'],
  ['A11Y-002', 'Complete the critical keyboard journey and show focus, dialog, search, and Escape responses.'],
  ['A11Y-003', 'Change browser zoom and show critical controls and content reflowing without loss.'],
  ['A11Y-004', 'Operate critical controls with a screen reader and capture their spoken state changes.'],
  ['REL-002', 'Operate theme and calculator controls with storage blocked and show current-page behavior surviving.'],
  ['DEVICE-001', 'Complete critical tap, navigation, form, and scroll journeys on physical iPhone Safari.'],
  ['DEVICE-002', 'Complete critical tap, navigation, form, and scroll journeys on physical Android Chrome.'],
  ['DEVICE-003', 'Complete critical touch and rotation journeys on a physical iPad in both orientations.'],
]);

const STATIC_SCREENSHOT_AUDIT_IDS = new Set([
  'ENV-001', 'ENV-002', 'ENV-005', 'ENV-006',
  'SHELL-002', 'SHELL-004', 'SHELL-006', 'NAV-008', 'THEME-003', 'THEME-004',
  'HOME-002', 'HOME-003', 'HOME-004', 'CRISIS-001', 'CRISIS-002',
  'CONTENT-001', 'CONTENT-002', 'CONTENT-004', 'CONTENT-005', 'CONTENT-006',
  'CONTENT-008', 'CALC-009', 'MEET-001', 'MEET-002', 'MEET-007', 'A11Y-001', 'A11Y-005',
  'REL-001', 'REL-003', 'PERF-002', 'SEO-001',
]);

const STRUCTURED_DATA_AUDIT_IDS = new Set([
  'ENV-003', 'ENV-004', 'ENV-008', 'CONTENT-003', 'PERF-001', 'SEO-002',
]);

const COMPARISON_ONLY_AUDIT_IDS = new Set([
  'ENV-003',
  'CONTENT-008',
]);

const STANDALONE_REQUIRED_AUDIT_IDS = new Set([
  'CONTENT-002',
]);

const STANDALONE_ORACLE_OVERRIDES = new Map<string, string>([
  ['ENV-001', 'The configured deployment origin returns usable, meaningful HTML over HTTPS.'],
  ['ENV-002', 'Every reviewed route for the audited deployment returns successful HTML with the expected canonical route.'],
  ['ENV-005', 'The confirmed Deployment Role has the intended indexing policy and internally consistent canonical metadata.'],
  ['ENV-006', 'The audited deployment returns the required security headers and long-lived caching for immutable assets.'],
  ['ENV-008', 'All first-party assets and JSON endpoints for the audited deployment load with correct status and content type.'],
  ['SEO-002', 'The audited deployment sitemap contains only live canonical pages and excludes drafts, aliases, and error pages.'],
]);

function singleSiteDefinitionMetadata(
  id: string,
  expected: string,
): Pick<AuditDefinition, 'singleSiteClassification' | 'standaloneOracle'> {
  const classification: AuditSingleSiteClassification = COMPARISON_ONLY_AUDIT_IDS.has(id)
    ? 'comparison-only'
    : STANDALONE_REQUIRED_AUDIT_IDS.has(id)
      ? 'standalone-required'
      : 'standalone-compatible';
  if (classification !== 'standalone-compatible') return { singleSiteClassification: classification };
  return {
    singleSiteClassification: classification,
    standaloneOracle: {
      id: `${id}:standalone`,
      expected: STANDALONE_ORACLE_OVERRIDES.get(id) ?? expected,
    },
  };
}

function coreEvidencePolicy(id: string, expected: string): AuditDefinition['evidencePolicy'] {
  const actionRationale = INTERACTION_VIDEO_RATIONALES.get(id);
  if (actionRationale) return createEvidencePolicy('interaction-video', actionRationale);
  if (STRUCTURED_DATA_AUDIT_IDS.has(id)) {
    return createEvidencePolicy('structured-data', `Retain machine-readable request and assertion evidence proving: ${expected}`);
  }
  if (STATIC_SCREENSHOT_AUDIT_IDS.has(id) || id.startsWith('PAGE-')) {
    return createEvidencePolicy('static-screenshot', `Capture the rendered state and structured evidence proving: ${expected}`);
  }
  throw new Error(`Core audit ${id} is missing an explicit evidence policy classification.`);
}

function audit(
  id: string,
  area: AuditArea,
  title: string,
  userPromise: string,
  expected: string,
  severity: AuditSeverity = 'P1',
  evidence: AuditDefinition['evidence'] = ['video', 'screenshot', 'json'],
  manual = false,
): AuditDefinition {
  const evidencePolicy = coreEvidencePolicy(id, expected);
  return {
    id,
    area,
    title,
    userPromise,
    expected,
    severity,
    releaseBlocking: severity === 'P0' || severity === 'P1',
    evidence: evidenceKindsForPolicy(evidence, evidencePolicy),
    evidencePolicy,
    ...singleSiteDefinitionMetadata(id, expected),
    manual,
  };
}

export const AUDIT_CATALOG: AuditDefinition[] = [
  audit('ENV-001', 'environment', 'Environment availability', 'Readers can reach the site securely.', 'Both configured origins return usable HTML over HTTPS.', 'P0', ['video', 'network', 'json']),
  audit('ENV-002', 'routes', 'Candidate route inventory', 'Every published guide remains reachable.', 'Every candidate route returns successful HTML with the expected canonical route.', 'P0', ['video', 'screenshot', 'network', 'json']),
  audit('ENV-003', 'routes', 'Production-first migration ledger', 'Renamed pages keep working after launch.', 'Every route discovered in the production sitemap maps to a live candidate destination or an explicit approved removal, and every candidate-only route is approved.', 'P0', ['network', 'json']),
  audit('ENV-004', 'routes', 'Redirect integrity', 'Bookmarks and search results do not break.', 'Legacy routes use a single permanent redirect without loops or chains.', 'P1', ['network', 'json']),
  audit('ENV-005', 'seo', 'Preview indexing controls', 'The beta environment does not compete with production in search.', 'Preview indexing policy is explicit and candidate canonical metadata is internally consistent.', 'P1', ['video', 'json']),
  audit('ENV-006', 'environment', 'Security and cache headers', 'Readers receive secure, correctly cached assets.', 'Required security headers exist and immutable assets use long-lived caching.', 'P1', ['network', 'json']),
  audit('ENV-007', 'routes', 'Custom not-found recovery', 'A bad link gives the reader a useful recovery path.', 'Unknown URLs return HTTP 404, expose the named accessible search, and let a reader reach a known recovery destination.', 'P1'),
  audit('ENV-008', 'environment', 'Static assets and data endpoints', 'The interface loads without missing fonts, images, icons, or data.', 'All first-party assets and JSON endpoints load with correct status and content type.', 'P0', ['video', 'network', 'json']),

  audit('SHELL-001', 'shell', 'Scheduling notice', 'Readers see current scheduling information without losing access to the page.', 'The notice renders, links correctly, dismisses, and remains dismissed after reload.', 'P1'),
  audit('SHELL-002', 'shell', 'Responsive header', 'Primary actions remain reachable at every supported width.', 'Header controls follow their documented breakpoint behavior without clipping or overlap.', 'P0'),
  audit('SHELL-003', 'shell', 'Skip link', 'Keyboard users can bypass repeated navigation.', 'The skip link becomes visible, targets visible main content, and makes its first control the next Tab stop.', 'P1', ['video', 'screenshot', 'axe', 'json']),
  audit('SHELL-004', 'shell', 'Footer navigation', 'Readers can reach urgent help, site information, and community destinations.', 'Footer links, labels, and external-link behavior are correct on mobile and desktop.', 'P1'),
  audit('SHELL-005', 'shell', 'Back to top', 'Long articles provide a reliable escape back to the beginning.', 'The control appears after meaningful scroll, returns to the top, and respects reduced motion.', 'P2'),
  audit('SHELL-006', 'responsive', 'Horizontal overflow guard', 'No reader must pan sideways to read ordinary pages.', 'Document width never exceeds viewport width except inside intentional scroll containers.', 'P0', ['video', 'screenshot', 'json']),

  audit('NAV-001', 'navigation', 'Mobile guide drawer', 'Mobile readers can browse the complete guide without losing their place.', 'Drawer opens, traps focus, closes by all expected methods, restores focus, and preserves scroll.', 'P0', ['video', 'screenshot', 'axe', 'json']),
  audit('NAV-002', 'navigation', 'Mobile category expansion', 'All category pages remain discoverable on a phone.', 'Category groups expand and collapse, current location is exposed, and links navigate correctly.', 'P1'),
  audit('NAV-003', 'navigation', 'Desktop sidebar persistence', 'Desktop readers can control reading space without losing their place.', 'Collapse state persists and the same visible reading anchor remains in view within a user-meaningful movement tolerance.', 'P1'),
  audit('NAV-004', 'navigation', 'Breadcrumb navigation and sharing', 'Readers know where they are and can copy a stable link.', 'Breadcrumb links navigate and copy produces the canonical page URL with confirmation.', 'P1'),
  audit('NAV-005', 'navigation', 'Table of contents', 'Readers can navigate long medical references reliably.', 'TOC links align headings below sticky chrome and active state tracks reading position.', 'P1'),
  audit('NAV-006', 'navigation', 'Heading permalinks', 'Readers can share a precise section.', 'Heading links update the hash, copy the URL, and announce success without a scroll jump.', 'P2'),
  audit('NAV-007', 'navigation', 'Previous and next pages', 'Sequential reading follows the configured guide order.', 'Previous and next destinations match category ordering and never point to drafts.', 'P2'),
  audit('NAV-008', 'navigation', 'Category indexes', 'Category landing pages accurately describe and enumerate their guides.', 'Grouping, page counts, update dates, and destinations agree with the route inventory.', 'P1'),

  audit('THEME-001', 'theme', 'Theme selection', 'Readers can choose system, light, or dark appearance.', 'All modes apply immediately and the chosen explicit mode persists.', 'P1'),
  audit('THEME-002', 'theme', 'System theme changes', 'System-mode readers follow operating-system appearance changes.', 'System mode updates live while explicit modes remain unchanged.', 'P2'),
  audit('THEME-003', 'theme', 'First-paint theme stability', 'Readers do not see a flash of the wrong theme.', 'The correct class is applied before first meaningful paint.', 'P1', ['video', 'screenshot', 'json']),
  audit('THEME-004', 'responsive', 'Breakpoint transitions', 'Controls neither disappear accidentally nor collide at layout thresholds.', 'Both sides of every custom breakpoint render without overlap, clipping, or unreachable actions.', 'P0'),

  audit('SEARCH-001', 'search', 'Header search dialog', 'Search is immediately available from any standard page.', 'Click and keyboard shortcut open the dialog, focus the input, and close predictably.', 'P0'),
  audit('SEARCH-002', 'search', 'Search result quality', 'Queries return relevant, understandable destinations.', 'Known terms return expected pages, highlights, categories, and excerpts.', 'P0'),
  audit('SEARCH-003', 'search', 'Search keyboard navigation', 'Search can be completed without a pointer.', 'Arrow keys move through results, Enter opens the active result, and Escape behaves by context.', 'P1'),
  audit('SEARCH-004', 'search', 'Search page filters', 'Readers can narrow a broad result set.', 'Topic and result-type filters combine correctly and persist in the URL.', 'P1'),
  audit('SEARCH-005', 'search', 'No-result guidance', 'A failed query does not become a dead end.', 'No-result guidance appears and replacing the query with a known treatment produces named, navigable results.', 'P2'),
  audit('SEARCH-006', 'reliability', 'Search failure fallback', 'A data-loading problem still leaves a route to content.', 'A failed index request shows the sitemap fallback and no indefinite spinner.', 'P1', ['video', 'screenshot', 'network', 'json']),

  audit('HOME-001', 'homepage', 'Homepage starting paths', 'A reader in distress can quickly choose the right next step.', 'Primary calls to action and common starting points are present and navigate correctly.', 'P0'),
  audit('HOME-002', 'homepage', 'Support-right-now panel', 'Current peer support is visible and understandable.', 'Live, upcoming, and fallback states show accurate labels and working destinations.', 'P0'),
  audit('HOME-003', 'homepage', 'Guide directory', 'Every guide category is discoverable from the homepage.', 'Category counts and destinations agree with the published inventory.', 'P1'),
  audit('HOME-004', 'homepage', 'Community status', 'Discord availability never breaks the page.', 'Live count renders when available and fails quietly with a usable Discord link.', 'P2'),
  audit('CRISIS-001', 'crisis', 'Crisis fast path', 'A reader in active withdrawal receives focused immediate actions.', 'The minimal layout excludes nonessential chrome and keeps every action visible and usable.', 'P0'),
  audit('CRISIS-002', 'crisis', 'Urgent contact actions', 'Emergency destinations can be reached without ambiguity.', 'Discord, live meeting, 988, symptom, and full-guide actions have correct destinations.', 'P0'),

  audit('CONTENT-001', 'content', 'Document structure', 'Every guide has a coherent, navigable document outline.', 'There is one visible H1, valid heading order, landmarks, description, and canonical metadata.', 'P1', ['video', 'screenshot', 'axe', 'json']),
  audit('CONTENT-002', 'content', 'Content rendering', 'No medically important text is hidden by a layout defect.', 'Text, lists, callouts, tables, code, blockquotes, and disclosures render without clipping.', 'P0'),
  audit('CONTENT-003', 'content', 'Internal links', 'Readers do not hit broken paths while seeking help.', 'All internal links resolve and fragments identify existing targets.', 'P0', ['network', 'json']),
  audit('CONTENT-004', 'content', 'External-link safety', 'Third-party destinations open without exposing the source tab.', 'External links use a new tab with noopener and noreferrer; internal links do not.', 'P1', ['json']),
  audit('CONTENT-005', 'content', 'Images and diagrams', 'Reference visuals remain legible and meaningful.', 'Every declared image, picture, SVG, and CSS diagram exists in its reviewed count, loads or renders, is labeled appropriately, fits the viewport, and works in both themes.', 'P1'),
  audit('CONTENT-006', 'content', 'Wide reference pages', 'Dense calculators and diagrams remain usable on narrow and wide screens.', 'Wide layout, responsive grids, and intentional table scrollers behave correctly.', 'P1'),
  audit('CONTENT-007', 'content', 'Long-page stability', 'Very long references remain responsive and navigable.', 'The changelog and long medical guides load, scroll, and update TOC state without lockups.', 'P2'),
  audit('CONTENT-008', 'content', 'Content parity ledger', 'Intentional redesign edits are distinguished from accidental omissions.', 'Critical headings, safety warnings, and CTA destinations remain present; every missing production heading must match the exact reviewed-difference ledger.', 'P0', ['screenshot', 'json']),

  audit('CALC-001', 'calculators', 'Taper defaults and derived totals', 'Calculator defaults produce an internally coherent plan.', 'Defaults and total-daily math match each selected substance.', 'P0'),
  audit('CALC-002', 'calculators', 'Taper input boundaries', 'Unexpected input cannot create a misleading or broken plan.', 'Blank and malformed drafts preserve the committed plan, explicit zero rejects it, and valid or overflowing boundaries produce exact restored or clamped output.', 'P0'),
  audit('CALC-003', 'calculators', 'Taper schedule generation', 'A reader receives mathematically correct day-by-day output.', 'Preset and custom schedules reach the requested jump-off with correct totals and frequency transitions.', 'P0'),
  audit('CALC-004', 'calculators', 'Calculator responsive output', 'Charts and schedules remain readable on a phone.', 'Chart, summary cards, tables, and touch hints render without page-level overflow.', 'P1'),
  audit('CALC-005', 'calculators', 'Calculator persistence and reset', 'Work survives an accidental reload and can be deliberately cleared.', 'Inputs persist per calculator, do not leak between tools, and reset to documented defaults.', 'P1'),
  audit('CALC-006', 'calculators', 'Calculator export actions', 'A plan can be copied or printed with understandable confirmation.', 'Schedule copy, AI-prompt copy, print window, and popup-blocked fallback behave correctly.', 'P1'),
  audit('CALC-007', 'calculators', 'SR-17 simple protocol', 'Simple mode produces the documented 7, 10, and 14-day protocols.', 'Dose tiers, schedule phases, totals, and 50 mg tablet supply calculations are correct.', 'P0'),
  audit('CALC-008', 'calculators', 'SR-17 advanced protocol', 'Advanced controls produce a coherent cross-taper.', 'Independent golden schedules prove allergy, preload, source reduction, hold, custom milligram, percentage, and jump-off boundaries update exact rows, duration, and supply.', 'P0'),
  audit('CALC-009', 'calculators', 'Calculator arithmetic black-box coverage', 'Interface evidence is backed by deterministic numeric tests.', 'Independent rendered black-box vectors cover a published schedule, a minimum-duration boundary, an explicit-zero stop boundary, and arithmetic invariants without importing site implementation code.', 'P0', ['json']),

  audit('SOWS-001', 'sows', 'SOWS scoring interaction', 'A reader can score every withdrawal symptom accurately.', 'All 16 items accept values zero through four and totals update after each answer.', 'P0'),
  audit('SOWS-002', 'sows', 'SOWS interpretation', 'Score guidance changes at the documented thresholds.', 'Partial, moderate, induction-window, and high-score states display the correct interpretation.', 'P0'),
  audit('SOWS-003', 'sows', 'SOWS logging and reset', 'A reader can preserve or clear a score without ambiguity.', 'Copy produces the visible score and timestamp; reset returns every item to zero.', 'P1'),
  audit('SHARE-001', 'content', 'Quickstart disclosures and copy', 'Compact setup information can be expanded and shared.', 'Disclosure, Reddit starter copy, and clipboard feedback work with denied-clipboard fallback.', 'P2'),

  audit('MEET-001', 'meetings', 'Meeting state transitions', 'Live and upcoming meeting labels are time-accurate.', 'Frozen pre-live, live, end-boundary, and no-specific-meeting states are correct.', 'P0'),
  audit('MEET-002', 'meetings', 'Meeting timezone conversion', 'Readers see times in their own timezone.', 'Times remain correct across US zones, Europe, India, and daylight-saving boundaries.', 'P0'),
  audit('MEET-003', 'meetings', 'Meeting history', 'Recently joined rooms remain easy to find and can be removed.', 'Join actions persist, update across pages, and support individual and full clearing.', 'P1'),
  audit('MEET-004', 'meetings', 'NA meeting discovery', 'A reader can narrow the large NA directory.', 'A known nonempty meeting set proves search, tag, platform, and access filters each exclude incompatible records, combine to the exact destination set, and clear back to baseline.', 'P1'),
  audit('MEET-005', 'meetings', 'SMART meeting discovery', 'A reader can narrow the SMART directory.', 'A known nonempty meeting set proves search, program, audience, and language filters each exclude incompatible records, combine to the exact destination set, and clear back to baseline.', 'P1'),
  audit('MEET-006', 'meetings', 'Meeting copy and join links', 'Meeting details can be copied and opened accurately.', 'Copy text, platform labels, phone links, and external join destinations match displayed details.', 'P0'),
  audit('MEET-007', 'reliability', 'Meeting data failure', 'A temporary data problem does not create false availability.', 'Transport aborts, HTTP errors, malformed payloads, and valid empty data settle without a spinner; failures are visibly distinct from a truthful empty result.', 'P1', ['screenshot', 'network', 'json']),

  audit('A11Y-001', 'accessibility', 'Automated WCAG scan', 'Common accessibility barriers are caught before release.', 'Representative pages and every opened overlay have no unapproved WCAG 2.0/2.1/2.2 A/AA axe violations, and every non-allowlisted incomplete result becomes a review finding.', 'P0', ['video', 'axe', 'json']),
  audit('A11Y-002', 'accessibility', 'Keyboard-only journeys', 'Critical tasks can be completed without a pointer.', 'Navigation, search, calculators, disclosures, and meeting filters have logical focus order and visible focus.', 'P0', ['video', 'screenshot', 'json']),
  audit('A11Y-003', 'accessibility', 'Zoom and text reflow', 'Low-vision readers retain all content and controls.', 'Critical pages work at 200% and 400% zoom without two-dimensional page scrolling.', 'P0', ['video', 'screenshot', 'json'], true),
  audit('A11Y-004', 'accessibility', 'Screen-reader acceptance', 'Live updates and controls make sense without sight.', 'VoiceOver announces dialogs, search results, copy feedback, scores, and live meeting changes.', 'P0', ['video', 'json'], true),
  audit('A11Y-005', 'accessibility', 'Reduced motion and non-color cues', 'Motion-sensitive and color-impaired readers receive equivalent information.', 'Motion is reduced and status remains understandable without relying on color.', 'P1', ['video', 'screenshot', 'json']),

  audit('REL-001', 'reliability', 'Runtime error guard', 'Pages do not silently break in a reader’s browser.', 'No unexpected page errors, console errors, failed first-party requests, or bad first-party responses occur.', 'P0', ['video', 'network', 'json']),
  audit('REL-002', 'reliability', 'Blocked browser storage', 'Privacy settings do not make core controls unusable.', 'Theme, sidebar, calculator, and history controls still work for the current page when storage is unavailable.', 'P1'),
  audit('REL-003', 'reliability', 'Slow and failed dependencies', 'Third-party outages do not block urgent site content.', 'Analytics, Discord, and meeting dependency failures degrade locally and visibly where needed.', 'P1', ['video', 'network', 'json']),

  audit('PERF-001', 'performance', 'Page performance budgets', 'Core guidance appears quickly on ordinary mobile connections.', 'After the load event and a bounded network-quiet window, Navigation Timing, late resources, transfer budgets, and Lighthouse metrics are present and within budget.', 'P1', ['lighthouse', 'json']),
  audit('PERF-002', 'performance', 'Layout stability', 'Late hydration does not move controls out from under the reader.', 'Observed layout shift and post-load geometry remain within the configured budget.', 'P1', ['video', 'json']),
  audit('SEO-001', 'seo', 'Metadata completeness', 'Search and sharing previews identify every page correctly.', 'Title, description, canonical, robots, Open Graph, and Twitter metadata are complete and valid.', 'P1', ['json']),
  audit('SEO-002', 'seo', 'Sitemap integrity', 'Search engines receive only valid canonical pages.', 'Sitemap entries resolve, are canonical, and exclude drafts, aliases, and error pages.', 'P1', ['network', 'json']),

  audit('DEVICE-001', 'responsive', 'Real iPhone Safari acceptance', 'The launch works in the browser used by many mobile readers.', 'Critical journeys pass on current and small-screen physical iPhones.', 'P0', ['video', 'screenshot', 'json'], true),
  audit('DEVICE-002', 'responsive', 'Real Android Chrome acceptance', 'The launch works on representative physical Android hardware.', 'Critical journeys pass on a current physical Pixel or Samsung device.', 'P0', ['video', 'screenshot', 'json'], true),
  audit('DEVICE-003', 'responsive', 'Real iPad Safari acceptance', 'Tablet readers receive a deliberate layout rather than a stretched phone page.', 'Critical journeys pass in portrait and landscape on a physical iPad.', 'P1', ['video', 'screenshot', 'json'], true),
];

export const AUDIT_BY_ID = new Map(AUDIT_CATALOG.map((definition) => [definition.id, definition]));

export function pageAuditDefinition(path: string): AuditDefinition {
  return audit(
    `PAGE-${path === '/' ? 'HOME' : path.slice(1).replaceAll('/', '-').toUpperCase()}`,
    'routes',
    `Page audit: ${path}`,
    'This published destination renders completely and remains usable.',
    'The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.',
    'P1',
    ['video', 'screenshot', 'network', 'axe', 'json'],
  );
}
