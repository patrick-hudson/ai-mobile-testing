# Assertion and audit contract ledger

This file is generated from the installed audit catalog and executable plugin registry. It is the reviewer-facing map from each stable audit ID to the product promise, deterministic oracle, evidence policy, executable source, applicability, and browser/device coverage. Edit the catalog, plugin manifests, or test declarations and regenerate this file; do not weaken a row to make a failing product pass.

The repository validation gate separately rejects literal/self-comparing assertions, swallowed promise failures, conditional-only oracles, observation-only tests, missing executable cases, placeholder contracts, and non-blocking P0/P1 definitions. A generated case proves that a declaration exists; the assertion-quality gate proves that its body contains a non-optional product-facing oracle.

## Coverage summary

- Authoritative audit contracts: 183
- Feature and cross-cutting contracts: 81
- Generated route-specific contracts: 102
- Automated contracts: 178
- Manual physical-device or assistive-technology contracts: 5
- Release-blocking contracts: 175
- Evidence modes: interaction-video 44, static-screenshot 133, structured-data 6

## Per-audit ledger

### ENV-001 — Environment availability

- Area: environment
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers can reach the site securely.
- Exact expected behavior: Both configured origins return usable HTML over HTTPS.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Both configured origins return usable HTML over HTTPS.
- Single-site classification: standalone-compatible — default oracle `ENV-001:standalone`
- Evidence attachments: `screenshot`, `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `plugins/platform-routes-content/tests/runtime.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: ENV-001:comparative`, `singleSite: ENV-001:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |
| `tests/contracts.spec.ts` | `all-projects` | `comparative`, `single-site` | `comparative: ENV-001:comparative`, `singleSite: ENV-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `production-desktop-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### ENV-002 — Candidate route inventory

- Area: routes
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Every published guide remains reachable.
- Exact expected behavior: Every candidate route returns successful HTML with the expected canonical route.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Every candidate route returns successful HTML with the expected canonical route.
- Single-site classification: standalone-compatible — default oracle `ENV-002:standalone`
- Evidence attachments: `screenshot`, `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: ENV-002:comparative`, `singleSite: ENV-002:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### ENV-003 — Production-first migration ledger

- Area: routes
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Renamed pages keep working after launch.
- Exact expected behavior: Every route discovered in the production sitemap maps to a live candidate destination or an explicit approved removal, and every candidate-only route is approved.
- Primary evidence: structured-data — Retain machine-readable request and assertion evidence proving: Every route discovered in the production sitemap maps to a live candidate destination or an explicit approved removal, and every candidate-only route is approved.
- Single-site classification: comparison-only
- Evidence attachments: `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `candidate-desktop-chromium` | `comparative` | `comparative: ENV-003:comparative` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### ENV-004 — Redirect integrity

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Bookmarks and search results do not break.
- Exact expected behavior: Legacy routes use a single permanent redirect without loops or chains.
- Primary evidence: structured-data — Retain machine-readable request and assertion evidence proving: Legacy routes use a single permanent redirect without loops or chains.
- Single-site classification: standalone-compatible — default oracle `ENV-004:standalone`
- Evidence attachments: `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: ENV-004:comparative`, `singleSite: ENV-004:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### ENV-005 — Preview indexing controls

- Area: seo
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: The beta environment does not compete with production in search.
- Exact expected behavior: Preview indexing policy is explicit and candidate canonical metadata is internally consistent.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Preview indexing policy is explicit and candidate canonical metadata is internally consistent.
- Single-site classification: standalone-compatible — default oracle `ENV-005:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `all-projects` | `comparative`, `single-site` | `comparative: ENV-005:comparative`, `singleSite: ENV-005:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `production-desktop-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### ENV-006 — Security and cache headers

- Area: environment
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers receive secure, correctly cached assets.
- Exact expected behavior: Required security headers exist and immutable assets use long-lived caching.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Required security headers exist and immutable assets use long-lived caching.
- Single-site classification: standalone-compatible — default oracle `ENV-006:standalone`
- Evidence attachments: `screenshot`, `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `all-projects` | `comparative`, `single-site` | `comparative: ENV-006:comparative`, `singleSite: ENV-006:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `production-desktop-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### ENV-007 — Custom not-found recovery

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A bad link gives the reader a useful recovery path.
- Exact expected behavior: Unknown URLs return HTTP 404, expose the named accessible search, and let a reader reach a known recovery destination.
- Primary evidence: interaction-video — Open an unknown URL, use its accessible search, and activate a known recovery destination.
- Single-site classification: standalone-compatible — default oracle `ENV-007:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `all-projects` | `comparative`, `single-site` | `comparative: ENV-007:comparative`, `singleSite: ENV-007:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `production-desktop-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### ENV-008 — Static assets and data endpoints

- Area: environment
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: The interface loads without missing fonts, images, icons, or data.
- Exact expected behavior: All first-party assets and JSON endpoints load with correct status and content type.
- Primary evidence: structured-data — Retain machine-readable request and assertion evidence proving: All first-party assets and JSON endpoints load with correct status and content type.
- Single-site classification: standalone-compatible — default oracle `ENV-008:standalone`
- Evidence attachments: `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: ENV-008:comparative`, `singleSite: ENV-008:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SHELL-001 — Scheduling notice

- Area: shell
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers see current scheduling information without losing access to the page.
- Exact expected behavior: The notice renders, links correctly, dismisses, and remains dismissed after reload.
- Primary evidence: interaction-video — Dismiss the scheduling notice, reload, and show that the notice remains dismissed.
- Single-site classification: standalone-compatible — default oracle `SHELL-001:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SHELL-001:comparative`, `singleSite: SHELL-001:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SHELL-002 — Responsive header

- Area: shell
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Primary actions remain reachable at every supported width.
- Exact expected behavior: Header controls follow their documented breakpoint behavior without clipping or overlap.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Header controls follow their documented breakpoint behavior without clipping or overlap.
- Single-site classification: standalone-compatible — default oracle `SHELL-002:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/theme-responsive.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: SHELL-002:comparative`, `singleSite: SHELL-002:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SHELL-003 — Skip link

- Area: shell
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Keyboard users can bypass repeated navigation.
- Exact expected behavior: The skip link becomes visible, targets visible main content, and makes its first control the next Tab stop.
- Primary evidence: interaction-video — Move keyboard focus to the skip link, activate it, and show the main fragment becoming the next sequential-focus entry point.
- Single-site classification: standalone-compatible — default oracle `SHELL-003:standalone`
- Evidence attachments: `video`, `axe`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SHELL-003:comparative`, `singleSite: SHELL-003:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SHELL-004 — Footer navigation

- Area: shell
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers can reach urgent help, site information, and community destinations.
- Exact expected behavior: Footer links, labels, and external-link behavior are correct on mobile and desktop.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Footer links, labels, and external-link behavior are correct on mobile and desktop.
- Single-site classification: standalone-compatible — default oracle `SHELL-004:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: SHELL-004:comparative`, `singleSite: SHELL-004:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SHELL-005 — Back to top

- Area: shell
- Severity and gate: P2; advisory
- Execution: automated; assertion-quality gate required
- User promise: Long articles provide a reliable escape back to the beginning.
- Exact expected behavior: The control appears after meaningful scroll, returns to the top, and respects reduced motion.
- Primary evidence: interaction-video — Scroll a long page, activate Back to top, and show the viewport returning to the beginning.
- Single-site classification: standalone-compatible — default oracle `SHELL-005:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SHELL-005:comparative`, `singleSite: SHELL-005:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SHELL-006 — Horizontal overflow guard

- Area: responsive
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: No reader must pan sideways to read ordinary pages.
- Exact expected behavior: Document width never exceeds viewport width except inside intentional scroll containers.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Document width never exceeds viewport width except inside intentional scroll containers.
- Single-site classification: standalone-compatible — default oracle `SHELL-006:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-mobile-chromium` | `comparative`, `single-site` | `comparative: SHELL-006:comparative`, `singleSite: SHELL-006:standalone` | `candidate-mobile-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14` |

### NAV-001 — Mobile guide drawer

- Area: navigation
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Mobile readers can browse the complete guide without losing their place.
- Exact expected behavior: Drawer opens, traps focus, closes by all expected methods, restores focus, and preserves scroll.
- Primary evidence: interaction-video — Open, operate, and close the mobile guide drawer while showing focus and scroll restoration.
- Single-site classification: standalone-compatible — default oracle `NAV-001:standalone`
- Evidence attachments: `video`, `axe`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/navigation.spec.ts` | `candidate-mobile-projects` | `comparative`, `single-site` | `comparative: NAV-001:comparative`, `singleSite: NAV-001:standalone` | `candidate-mobile-chromium`, `candidate-mobile-webkit`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14` |

### NAV-002 — Mobile category expansion

- Area: navigation
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: All category pages remain discoverable on a phone.
- Exact expected behavior: Category groups expand and collapse, current location is exposed, and links navigate correctly.
- Primary evidence: interaction-video — Expand and collapse mobile guide categories and show their links and current-page state responding.
- Single-site classification: standalone-compatible — default oracle `NAV-002:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/navigation.spec.ts` | `candidate-mobile-chromium` | `comparative`, `single-site` | `comparative: NAV-002:comparative`, `singleSite: NAV-002:standalone` | `candidate-mobile-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14` |

### NAV-003 — Desktop sidebar persistence

- Area: navigation
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Desktop readers can control reading space without losing their place.
- Exact expected behavior: Collapse state persists and the same visible reading anchor remains in view within a user-meaningful movement tolerance.
- Primary evidence: interaction-video — Collapse, reload, and expand the desktop sidebar while showing persistence and stable reading position.
- Single-site classification: standalone-compatible — default oracle `NAV-003:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/navigation.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: NAV-003:comparative`, `singleSite: NAV-003:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### NAV-004 — Breadcrumb navigation and sharing

- Area: navigation
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers know where they are and can copy a stable link.
- Exact expected behavior: Breadcrumb links navigate and copy produces the canonical page URL with confirmation.
- Primary evidence: interaction-video — Activate breadcrumb sharing and show the canonical page URL copied to the clipboard.
- Single-site classification: standalone-compatible — default oracle `NAV-004:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/navigation.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: NAV-004:comparative`, `singleSite: NAV-004:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### NAV-005 — Table of contents

- Area: navigation
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers can navigate long medical references reliably.
- Exact expected behavior: TOC links align headings below sticky chrome and active state tracks reading position.
- Primary evidence: interaction-video — Activate a table-of-contents link and show hash, heading alignment, and active reading position.
- Single-site classification: standalone-compatible — default oracle `NAV-005:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/navigation.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: NAV-005:comparative`, `singleSite: NAV-005:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### NAV-006 — Heading permalinks

- Area: navigation
- Severity and gate: P2; advisory
- Execution: automated; assertion-quality gate required
- User promise: Readers can share a precise section.
- Exact expected behavior: Heading links update the hash, copy the URL, and announce success without a scroll jump.
- Primary evidence: interaction-video — Activate a heading permalink and show its hash, clipboard confirmation, and stable scroll position.
- Single-site classification: standalone-compatible — default oracle `NAV-006:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: NAV-006:comparative`, `singleSite: NAV-006:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### NAV-007 — Previous and next pages

- Area: navigation
- Severity and gate: P2; advisory
- Execution: automated; assertion-quality gate required
- User promise: Sequential reading follows the configured guide order.
- Exact expected behavior: Previous and next destinations match category ordering and never point to drafts.
- Primary evidence: interaction-video — Activate previous and next reading controls and show both intended guide destinations loading.
- Single-site classification: standalone-compatible — default oracle `NAV-007:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: NAV-007:comparative`, `singleSite: NAV-007:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### NAV-008 — Category indexes

- Area: navigation
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Category landing pages accurately describe and enumerate their guides.
- Exact expected behavior: Grouping, page counts, update dates, and destinations agree with the route inventory.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Grouping, page counts, update dates, and destinations agree with the route inventory.
- Single-site classification: standalone-compatible — default oracle `NAV-008:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: NAV-008:comparative`, `singleSite: NAV-008:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### THEME-001 — Theme selection

- Area: theme
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers can choose system, light, or dark appearance.
- Exact expected behavior: All modes apply immediately and the chosen explicit mode persists.
- Primary evidence: interaction-video — Choose light and dark modes and show the selected appearance applying and persisting.
- Single-site classification: standalone-compatible — default oracle `THEME-001:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/theme-responsive.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: THEME-001:comparative`, `singleSite: THEME-001:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### THEME-002 — System theme changes

- Area: theme
- Severity and gate: P2; advisory
- Execution: automated; assertion-quality gate required
- User promise: System-mode readers follow operating-system appearance changes.
- Exact expected behavior: System mode updates live while explicit modes remain unchanged.
- Primary evidence: interaction-video — Choose system appearance, change the emulated system scheme, and show the page following it.
- Single-site classification: standalone-compatible — default oracle `THEME-002:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: THEME-002:comparative`, `singleSite: THEME-002:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### THEME-003 — First-paint theme stability

- Area: theme
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers do not see a flash of the wrong theme.
- Exact expected behavior: The correct class is applied before first meaningful paint.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The correct class is applied before first meaningful paint.
- Single-site classification: standalone-compatible — default oracle `THEME-003:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/theme-responsive.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: THEME-003:comparative`, `singleSite: THEME-003:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### THEME-004 — Breakpoint transitions

- Area: responsive
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Controls neither disappear accidentally nor collide at layout thresholds.
- Exact expected behavior: Both sides of every custom breakpoint render without overlap, clipping, or unreachable actions.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Both sides of every custom breakpoint render without overlap, clipping, or unreachable actions.
- Single-site classification: standalone-compatible — default oracle `THEME-004:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/theme-responsive.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: THEME-004:comparative`, `singleSite: THEME-004:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SEARCH-001 — Header search dialog

- Area: search
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Search is immediately available from any standard page.
- Exact expected behavior: Click and keyboard shortcut open the dialog, focus the input, and close predictably.
- Primary evidence: interaction-video — Open and close search with pointer and keyboard controls and show predictable focus movement.
- Single-site classification: standalone-compatible — default oracle `SEARCH-001:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/search.spec.ts` | `candidate-projects` | `comparative`, `single-site` | `comparative: SEARCH-001:comparative`, `singleSite: SEARCH-001:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SEARCH-002 — Search result quality

- Area: search
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Queries return relevant, understandable destinations.
- Exact expected behavior: Known terms return expected pages, highlights, categories, and excerpts.
- Primary evidence: interaction-video — Enter a known query and show relevant search results and excerpts responding.
- Single-site classification: standalone-compatible — default oracle `SEARCH-002:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/search.spec.ts` | `candidate-projects` | `comparative`, `single-site` | `comparative: SEARCH-002:comparative`, `singleSite: SEARCH-002:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SEARCH-003 — Search keyboard navigation

- Area: search
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Search can be completed without a pointer.
- Exact expected behavior: Arrow keys move through results, Enter opens the active result, and Escape behaves by context.
- Primary evidence: interaction-video — Use keyboard result navigation and show Enter opening the active destination.
- Single-site classification: standalone-compatible — default oracle `SEARCH-003:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/search.spec.ts` | `candidate-non-tablet-projects` | `comparative`, `single-site` | `comparative: SEARCH-003:comparative`, `singleSite: SEARCH-003:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SEARCH-004 — Search page filters

- Area: search
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers can narrow a broad result set.
- Exact expected behavior: Topic and result-type filters combine correctly and persist in the URL.
- Primary evidence: interaction-video — Apply search filters and show the result set and URL state updating together.
- Single-site classification: standalone-compatible — default oracle `SEARCH-004:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/search.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SEARCH-004:comparative`, `singleSite: SEARCH-004:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SEARCH-005 — No-result guidance

- Area: search
- Severity and gate: P2; advisory
- Execution: automated; assertion-quality gate required
- User promise: A failed query does not become a dead end.
- Exact expected behavior: No-result guidance appears and replacing the query with a known treatment produces named, navigable results.
- Primary evidence: interaction-video — Enter one absent token, verify the no-result state, then replace it with a known treatment and use the recovered results.
- Single-site classification: standalone-compatible — default oracle `SEARCH-005:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/search.spec.ts` | `candidate-projects` | `comparative`, `single-site` | `comparative: SEARCH-005:comparative`, `singleSite: SEARCH-005:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SEARCH-006 — Search failure fallback

- Area: reliability
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A data-loading problem still leaves a route to content.
- Exact expected behavior: A failed index request shows the sitemap fallback and no indefinite spinner.
- Primary evidence: interaction-video — Enter a search while its index request fails and show the usable sitemap fallback.
- Single-site classification: standalone-compatible — default oracle `SEARCH-006:standalone`
- Evidence attachments: `video`, `network`, `json`
- Owning plugins: `shell-navigation-theme-search`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/search.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SEARCH-006:comparative`, `singleSite: SEARCH-006:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### HOME-001 — Homepage starting paths

- Area: homepage
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A reader in distress can quickly choose the right next step.
- Exact expected behavior: Primary calls to action and common starting points are present and navigate correctly.
- Primary evidence: interaction-video — Activate a primary homepage starting path and show the intended guide destination loading.
- Single-site classification: standalone-compatible — default oracle `HOME-001:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/smoke.spec.ts` | `all-projects` | `comparative`, `single-site` | `comparative: HOME-001:comparative`, `singleSite: HOME-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `production-desktop-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### HOME-002 — Support-right-now panel

- Area: homepage
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Current peer support is visible and understandable.
- Exact expected behavior: Live, upcoming, and fallback states show accurate labels and working destinations.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Live, upcoming, and fallback states show accurate labels and working destinations.
- Single-site classification: standalone-compatible — default oracle `HOME-002:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/content-system.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: HOME-002:comparative`, `singleSite: HOME-002:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### HOME-003 — Guide directory

- Area: homepage
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Every guide category is discoverable from the homepage.
- Exact expected behavior: Category counts and destinations agree with the published inventory.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Category counts and destinations agree with the published inventory.
- Single-site classification: standalone-compatible — default oracle `HOME-003:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: HOME-003:comparative`, `singleSite: HOME-003:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### HOME-004 — Community status

- Area: homepage
- Severity and gate: P2; advisory
- Execution: automated; assertion-quality gate required
- User promise: Discord availability never breaks the page.
- Exact expected behavior: Live count renders when available and fails quietly with a usable Discord link.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Live count renders when available and fails quietly with a usable Discord link.
- Single-site classification: standalone-compatible — default oracle `HOME-004:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: HOME-004:comparative`, `singleSite: HOME-004:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CRISIS-001 — Crisis fast path

- Area: crisis
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A reader in active withdrawal receives focused immediate actions.
- Exact expected behavior: The minimal layout excludes nonessential chrome and keeps every action visible and usable.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The minimal layout excludes nonessential chrome and keeps every action visible and usable.
- Single-site classification: standalone-compatible — default oracle `CRISIS-001:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-mobile-chromium` | `comparative`, `single-site` | `comparative: CRISIS-001:comparative`, `singleSite: CRISIS-001:standalone` | `candidate-mobile-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14` |

### CRISIS-002 — Urgent contact actions

- Area: crisis
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Emergency destinations can be reached without ambiguity.
- Exact expected behavior: Discord, live meeting, 988, symptom, and full-guide actions have correct destinations.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Discord, live meeting, 988, symptom, and full-guide actions have correct destinations.
- Single-site classification: standalone-compatible — default oracle `CRISIS-002:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/smoke.spec.ts` | `candidate-projects` | `comparative`, `single-site` | `comparative: CRISIS-002:comparative`, `singleSite: CRISIS-002:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CONTENT-001 — Document structure

- Area: content
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Every guide has a coherent, navigable document outline.
- Exact expected behavior: There is one visible H1, valid heading order, landmarks, description, and canonical metadata.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: There is one visible H1, valid heading order, landmarks, description, and canonical metadata.
- Single-site classification: standalone-compatible — default oracle `CONTENT-001:standalone`
- Evidence attachments: `screenshot`, `axe`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/content-system.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: CONTENT-001:comparative`, `singleSite: CONTENT-001:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CONTENT-002 — Content rendering

- Area: content
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: No medically important text is hidden by a layout defect.
- Exact expected behavior: Text, lists, callouts, tables, code, blockquotes, and disclosures render without clipping.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Text, lists, callouts, tables, code, blockquotes, and disclosures render without clipping.
- Single-site classification: standalone-required
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/visual-regression.spec.ts` | `candidate-chromium-projects` | `single-site` | `singleSite: CONTENT-002:standalone-content-primitives` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |
| `tests/visual-regression.spec.ts` | `candidate-projects` | `comparative` | `comparative: CONTENT-002:comparative` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CONTENT-003 — Internal links

- Area: content
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers do not hit broken paths while seeking help.
- Exact expected behavior: All internal links resolve and fragments identify existing targets.
- Primary evidence: structured-data — Retain machine-readable request and assertion evidence proving: All internal links resolve and fragments identify existing targets.
- Single-site classification: standalone-compatible — default oracle `CONTENT-003:standalone`
- Evidence attachments: `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/content-system.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: CONTENT-003:comparative`, `singleSite: CONTENT-003:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CONTENT-004 — External-link safety

- Area: content
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Third-party destinations open without exposing the source tab.
- Exact expected behavior: External links use a new tab with noopener and noreferrer; internal links do not.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: External links use a new tab with noopener and noreferrer; internal links do not.
- Single-site classification: standalone-compatible — default oracle `CONTENT-004:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/content-system.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: CONTENT-004:comparative`, `singleSite: CONTENT-004:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CONTENT-005 — Images and diagrams

- Area: content
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Reference visuals remain legible and meaningful.
- Exact expected behavior: Every declared image, picture, SVG, and CSS diagram exists in its reviewed count, loads or renders, is labeled appropriately, fits the viewport, and works in both themes.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Every declared image, picture, SVG, and CSS diagram exists in its reviewed count, loads or renders, is labeled appropriately, fits the viewport, and works in both themes.
- Single-site classification: standalone-compatible — default oracle `CONTENT-005:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/content-system.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: CONTENT-005:comparative`, `singleSite: CONTENT-005:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CONTENT-006 — Wide reference pages

- Area: content
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Dense calculators and diagrams remain usable on narrow and wide screens.
- Exact expected behavior: Wide layout, responsive grids, and intentional table scrollers behave correctly.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Wide layout, responsive grids, and intentional table scrollers behave correctly.
- Single-site classification: standalone-compatible — default oracle `CONTENT-006:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/content-system.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: CONTENT-006:comparative`, `singleSite: CONTENT-006:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CONTENT-007 — Long-page stability

- Area: content
- Severity and gate: P2; advisory
- Execution: automated; assertion-quality gate required
- User promise: Very long references remain responsive and navigable.
- Exact expected behavior: The changelog and long medical guides load, scroll, and update TOC state without lockups.
- Primary evidence: interaction-video — Scroll progressively through long references and show that reading and navigation remain responsive.
- Single-site classification: standalone-compatible — default oracle `CONTENT-007:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/content-system.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: CONTENT-007:comparative`, `singleSite: CONTENT-007:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CONTENT-008 — Content parity ledger

- Area: content
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Intentional redesign edits are distinguished from accidental omissions.
- Exact expected behavior: Critical headings, safety warnings, and CTA destinations remain present; every missing production heading must match the exact reviewed-difference ledger.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Critical headings, safety warnings, and CTA destinations remain present; every missing production heading must match the exact reviewed-difference ledger.
- Single-site classification: comparison-only
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/content-system.spec.ts` | `candidate-desktop-chromium` | `comparative` | `comparative: CONTENT-008:comparative` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CALC-001 — Taper defaults and derived totals

- Area: calculators
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Calculator defaults produce an internally coherent plan.
- Exact expected behavior: Defaults and total-daily math match each selected substance.
- Primary evidence: interaction-video — Select calculator inputs and show derived dose totals updating coherently.
- Single-site classification: standalone-compatible — default oracle `CALC-001:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: CALC-001:comparative`, `singleSite: CALC-001:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CALC-002 — Taper input boundaries

- Area: calculators
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Unexpected input cannot create a misleading or broken plan.
- Exact expected behavior: Blank and malformed drafts preserve the committed plan, explicit zero rejects it, and valid or overflowing boundaries produce exact restored or clamped output.
- Primary evidence: interaction-video — Enter boundary and malformed calculator drafts and show exact preserve, reject, restore, and clamp responses.
- Single-site classification: standalone-compatible — default oracle `CALC-002:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: CALC-002:comparative`, `singleSite: CALC-002:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CALC-003 — Taper schedule generation

- Area: calculators
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A reader receives mathematically correct day-by-day output.
- Exact expected behavior: Preset and custom schedules reach the requested jump-off with correct totals and frequency transitions.
- Primary evidence: interaction-video — Configure a custom taper and show the generated day-by-day schedule responding.
- Single-site classification: standalone-compatible — default oracle `CALC-003:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: CALC-003:comparative`, `singleSite: CALC-003:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CALC-004 — Calculator responsive output

- Area: calculators
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Charts and schedules remain readable on a phone.
- Exact expected behavior: Chart, summary cards, tables, and touch hints render without page-level overflow.
- Primary evidence: interaction-video — Change calculator inputs at a mobile viewport and show responsive output remaining usable.
- Single-site classification: standalone-compatible — default oracle `CALC-004:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-mobile-chromium` | `comparative`, `single-site` | `comparative: CALC-004:comparative`, `singleSite: CALC-004:standalone` | `candidate-mobile-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14` |

### CALC-005 — Calculator persistence and reset

- Area: calculators
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Work survives an accidental reload and can be deliberately cleared.
- Exact expected behavior: Inputs persist per calculator, do not leak between tools, and reset to documented defaults.
- Primary evidence: interaction-video — Change, reload, and reset calculator inputs and show persistence followed by deliberate clearing.
- Single-site classification: standalone-compatible — default oracle `CALC-005:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: CALC-005:comparative`, `singleSite: CALC-005:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CALC-006 — Calculator export actions

- Area: calculators
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A plan can be copied or printed with understandable confirmation.
- Exact expected behavior: Schedule copy, AI-prompt copy, print window, and popup-blocked fallback behave correctly.
- Primary evidence: interaction-video — Use calculator copy and print actions and show the exported plan and confirmations.
- Single-site classification: standalone-compatible — default oracle `CALC-006:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: CALC-006:comparative`, `singleSite: CALC-006:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CALC-007 — SR-17 simple protocol

- Area: calculators
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Simple mode produces the documented 7, 10, and 14-day protocols.
- Exact expected behavior: Dose tiers, schedule phases, totals, and 50 mg tablet supply calculations are correct.
- Primary evidence: interaction-video — Choose SR-17 simple protocol controls and show each documented schedule being generated.
- Single-site classification: standalone-compatible — default oracle `CALC-007:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: CALC-007:comparative`, `singleSite: CALC-007:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CALC-008 — SR-17 advanced protocol

- Area: calculators
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Advanced controls produce a coherent cross-taper.
- Exact expected behavior: Independent golden schedules prove allergy, preload, source reduction, hold, custom milligram, percentage, and jump-off boundaries update exact rows, duration, and supply.
- Primary evidence: interaction-video — Change SR-17 advanced controls and show each cross-taper phase updating.
- Single-site classification: standalone-compatible — default oracle `CALC-008:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: CALC-008:comparative`, `singleSite: CALC-008:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### CALC-009 — Calculator arithmetic black-box coverage

- Area: calculators
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Interface evidence is backed by deterministic numeric tests.
- Exact expected behavior: Independent rendered black-box vectors cover a published schedule, a minimum-duration boundary, an explicit-zero stop boundary, and arithmetic invariants without importing site implementation code.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Independent rendered black-box vectors cover a published schedule, a minimum-duration boundary, an explicit-zero stop boundary, and arithmetic invariants without importing site implementation code.
- Single-site classification: standalone-compatible — default oracle `CALC-009:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/calculators.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: CALC-009:comparative`, `singleSite: CALC-009:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SOWS-001 — SOWS scoring interaction

- Area: sows
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A reader can score every withdrawal symptom accurately.
- Exact expected behavior: All 16 items accept values zero through four and totals update after each answer.
- Primary evidence: interaction-video — Answer all withdrawal items and show the visible total updating after each choice.
- Single-site classification: standalone-compatible — default oracle `SOWS-001:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/sows.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SOWS-001:comparative`, `singleSite: SOWS-001:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SOWS-002 — SOWS interpretation

- Area: sows
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Score guidance changes at the documented thresholds.
- Exact expected behavior: Partial, moderate, induction-window, and high-score states display the correct interpretation.
- Primary evidence: interaction-video — Change SOWS answers across thresholds and show the interpretation responding.
- Single-site classification: standalone-compatible — default oracle `SOWS-002:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/sows.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: SOWS-002:comparative`, `singleSite: SOWS-002:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SOWS-003 — SOWS logging and reset

- Area: sows
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A reader can preserve or clear a score without ambiguity.
- Exact expected behavior: Copy produces the visible score and timestamp; reset returns every item to zero.
- Primary evidence: interaction-video — Copy, collapse, reopen, and reset a SOWS score and show each state transition.
- Single-site classification: standalone-compatible — default oracle `SOWS-003:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/sows.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SOWS-003:comparative`, `singleSite: SOWS-003:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SHARE-001 — Quickstart disclosures and copy

- Area: content
- Severity and gate: P2; advisory
- Execution: automated; assertion-quality gate required
- User promise: Compact setup information can be expanded and shared.
- Exact expected behavior: Disclosure, Reddit starter copy, and clipboard feedback work with denied-clipboard fallback.
- Primary evidence: interaction-video — Activate the quickstart copy action and show clipboard contents and visible confirmation.
- Single-site classification: standalone-compatible — default oracle `SHARE-001:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `calculators-sows`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SHARE-001:comparative`, `singleSite: SHARE-001:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### MEET-001 — Meeting state transitions

- Area: meetings
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Live and upcoming meeting labels are time-accurate.
- Exact expected behavior: Frozen pre-live, live, end-boundary, and no-specific-meeting states are correct.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Frozen pre-live, live, end-boundary, and no-specific-meeting states are correct.
- Single-site classification: standalone-compatible — default oracle `MEET-001:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `meetings`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/meetings.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: MEET-001:comparative`, `singleSite: MEET-001:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### MEET-002 — Meeting timezone conversion

- Area: meetings
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Readers see times in their own timezone.
- Exact expected behavior: Times remain correct across US zones, Europe, India, and daylight-saving boundaries.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Times remain correct across US zones, Europe, India, and daylight-saving boundaries.
- Single-site classification: standalone-compatible — default oracle `MEET-002:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `meetings`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/meetings.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: MEET-002:comparative`, `singleSite: MEET-002:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### MEET-003 — Meeting history

- Area: meetings
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Recently joined rooms remain easy to find and can be removed.
- Exact expected behavior: Join actions persist, update across pages, and support individual and full clearing.
- Primary evidence: interaction-video — Join a meeting, navigate to history, and clear it while showing persistence and removal.
- Single-site classification: standalone-compatible — default oracle `MEET-003:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `meetings`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/meetings.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: MEET-003:comparative`, `singleSite: MEET-003:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### MEET-004 — NA meeting discovery

- Area: meetings
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A reader can narrow the large NA directory.
- Exact expected behavior: A known nonempty meeting set proves search, tag, platform, and access filters each exclude incompatible records, combine to the exact destination set, and clear back to baseline.
- Primary evidence: interaction-video — Combine and clear NA meeting filters and show empty and restored result states.
- Single-site classification: standalone-compatible — default oracle `MEET-004:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `meetings`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/meetings.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: MEET-004:comparative`, `singleSite: MEET-004:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### MEET-005 — SMART meeting discovery

- Area: meetings
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A reader can narrow the SMART directory.
- Exact expected behavior: A known nonempty meeting set proves search, program, audience, and language filters each exclude incompatible records, combine to the exact destination set, and clear back to baseline.
- Primary evidence: interaction-video — Combine and clear SMART meeting filters and show empty and restored result states.
- Single-site classification: standalone-compatible — default oracle `MEET-005:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `meetings`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/meetings.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: MEET-005:comparative`, `singleSite: MEET-005:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### MEET-006 — Meeting copy and join links

- Area: meetings
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Meeting details can be copied and opened accurately.
- Exact expected behavior: Copy text, platform labels, phone links, and external join destinations match displayed details.
- Primary evidence: interaction-video — Activate meeting copy and join controls and show clipboard data matching the displayed destination.
- Single-site classification: standalone-compatible — default oracle `MEET-006:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `meetings`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/meetings.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: MEET-006:comparative`, `singleSite: MEET-006:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### MEET-007 — Meeting data failure

- Area: reliability
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: A temporary data problem does not create false availability.
- Exact expected behavior: Transport aborts, HTTP errors, malformed payloads, and valid empty data settle without a spinner; failures are visibly distinct from a truthful empty result.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Transport aborts, HTTP errors, malformed payloads, and valid empty data settle without a spinner; failures are visibly distinct from a truthful empty result.
- Single-site classification: standalone-compatible — default oracle `MEET-007:standalone`
- Evidence attachments: `screenshot`, `network`, `json`
- Owning plugins: `meetings`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/meetings.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: MEET-007:comparative`, `singleSite: MEET-007:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### A11Y-001 — Automated WCAG scan

- Area: accessibility
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Common accessibility barriers are caught before release.
- Exact expected behavior: Representative pages and every opened overlay have no unapproved WCAG 2.0/2.1/2.2 A/AA axe violations, and every non-allowlisted incomplete result becomes a review finding.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Representative pages and every opened overlay have no unapproved WCAG 2.0/2.1/2.2 A/AA axe violations, and every non-allowlisted incomplete result becomes a review finding.
- Single-site classification: standalone-compatible — default oracle `A11Y-001:standalone`
- Evidence attachments: `screenshot`, `axe`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/accessibility.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: A11Y-001:comparative`, `singleSite: A11Y-001:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |
| `tests/accessibility.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: A11Y-001:comparative`, `singleSite: A11Y-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/accessibility.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: A11Y-001:comparative`, `singleSite: A11Y-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/accessibility.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: A11Y-001:comparative`, `singleSite: A11Y-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/accessibility.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: A11Y-001:comparative`, `singleSite: A11Y-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/accessibility.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: A11Y-001:comparative`, `singleSite: A11Y-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/accessibility.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: A11Y-001:comparative`, `singleSite: A11Y-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/accessibility.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: A11Y-001:comparative`, `singleSite: A11Y-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### A11Y-002 — Keyboard-only journeys

- Area: accessibility
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Critical tasks can be completed without a pointer.
- Exact expected behavior: Navigation, search, calculators, disclosures, and meeting filters have logical focus order and visible focus.
- Primary evidence: interaction-video — Complete the critical keyboard journey and show focus, dialog, search, and Escape responses.
- Single-site classification: standalone-compatible — default oracle `A11Y-002:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/accessibility.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: A11Y-002:comparative`, `singleSite: A11Y-002:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### A11Y-003 — Zoom and text reflow

- Area: accessibility
- Severity and gate: P0; release blocking
- Execution: manual evidence and attestation required
- User promise: Low-vision readers retain all content and controls.
- Exact expected behavior: Critical pages work at 200% and 400% zoom without two-dimensional page scrolling.
- Primary evidence: interaction-video — Change browser zoom and show critical controls and content reflowing without loss.
- Single-site classification: standalone-compatible — default oracle `A11Y-003:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

Manual coverage has no automated source case; the long checklist remains incomplete until a reviewer attaches and attests valid evidence.

### A11Y-004 — Screen-reader acceptance

- Area: accessibility
- Severity and gate: P0; release blocking
- Execution: manual evidence and attestation required
- User promise: Live updates and controls make sense without sight.
- Exact expected behavior: VoiceOver announces dialogs, search results, copy feedback, scores, and live meeting changes.
- Primary evidence: interaction-video — Operate critical controls with a screen reader and capture their spoken state changes.
- Single-site classification: standalone-compatible — default oracle `A11Y-004:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

Manual coverage has no automated source case; the long checklist remains incomplete until a reviewer attaches and attests valid evidence.

### A11Y-005 — Reduced motion and non-color cues

- Area: accessibility
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Motion-sensitive and color-impaired readers receive equivalent information.
- Exact expected behavior: Motion is reduced and status remains understandable without relying on color.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Motion is reduced and status remains understandable without relying on color.
- Single-site classification: standalone-compatible — default oracle `A11Y-005:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/accessibility.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: A11Y-005:comparative`, `singleSite: A11Y-005:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### REL-001 — Runtime error guard

- Area: reliability
- Severity and gate: P0; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Pages do not silently break in a reader’s browser.
- Exact expected behavior: No unexpected page errors, console errors, failed first-party requests, or bad first-party responses occur.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: No unexpected page errors, console errors, failed first-party requests, or bad first-party responses occur.
- Single-site classification: standalone-compatible — default oracle `REL-001:standalone`
- Evidence attachments: `screenshot`, `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/smoke.spec.ts` | `all-projects` | `comparative`, `single-site` | `comparative: REL-001:comparative`, `singleSite: REL-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `production-desktop-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### REL-002 — Blocked browser storage

- Area: reliability
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Privacy settings do not make core controls unusable.
- Exact expected behavior: Theme, sidebar, calculator, and history controls still work for the current page when storage is unavailable.
- Primary evidence: interaction-video — Operate theme and calculator controls with storage blocked and show current-page behavior surviving.
- Single-site classification: standalone-compatible — default oracle `REL-002:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: REL-002:comparative`, `singleSite: REL-002:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### REL-003 — Slow and failed dependencies

- Area: reliability
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Third-party outages do not block urgent site content.
- Exact expected behavior: Analytics, Discord, and meeting dependency failures degrade locally and visibly where needed.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Analytics, Discord, and meeting dependency failures degrade locally and visibly where needed.
- Single-site classification: standalone-compatible — default oracle `REL-003:standalone`
- Evidence attachments: `screenshot`, `network`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/shell-content.spec.ts` | `candidate-desktop-chromium` | `comparative`, `single-site` | `comparative: REL-003:comparative`, `singleSite: REL-003:standalone` | `candidate-desktop-chromium`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### PERF-001 — Page performance budgets

- Area: performance
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Core guidance appears quickly on ordinary mobile connections.
- Exact expected behavior: After the load event and a bounded network-quiet window, Navigation Timing, late resources, transfer budgets, and Lighthouse metrics are present and within budget.
- Primary evidence: structured-data — Retain machine-readable request and assertion evidence proving: After the load event and a bounded network-quiet window, Navigation Timing, late resources, transfer budgets, and Lighthouse metrics are present and within budget.
- Single-site classification: standalone-compatible — default oracle `PERF-001:standalone`
- Evidence attachments: `lighthouse`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-001:comparative`, `singleSite: PERF-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-001:comparative`, `singleSite: PERF-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-001:comparative`, `singleSite: PERF-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-001:comparative`, `singleSite: PERF-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-001:comparative`, `singleSite: PERF-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PERF-002 — Layout stability

- Area: performance
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Late hydration does not move controls out from under the reader.
- Exact expected behavior: Observed layout shift and post-load geometry remain within the configured budget.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Observed layout shift and post-load geometry remain within the configured budget.
- Single-site classification: standalone-compatible — default oracle `PERF-002:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-002:comparative`, `singleSite: PERF-002:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-002:comparative`, `singleSite: PERF-002:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-002:comparative`, `singleSite: PERF-002:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-002:comparative`, `singleSite: PERF-002:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
| `tests/performance.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PERF-002:comparative`, `singleSite: PERF-002:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### SEO-001 — Metadata completeness

- Area: seo
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Search and sharing previews identify every page correctly.
- Exact expected behavior: Title, description, canonical, robots, Open Graph, and Twitter metadata are complete and valid.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: Title, description, canonical, robots, Open Graph, and Twitter metadata are complete and valid.
- Single-site classification: standalone-compatible — default oracle `SEO-001:standalone`
- Evidence attachments: `screenshot`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `all-projects` | `comparative`, `single-site` | `comparative: SEO-001:comparative`, `singleSite: SEO-001:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `production-desktop-chromium`, `candidate-desktop-chromium`, `candidate-mobile-webkit`, `candidate-tablet-webkit`, `candidate-desktop-firefox`, `candidate-mobile-webkit-iphone-17-ios18`, `candidate-mobile-webkit-iphone-15-ios17`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### SEO-002 — Sitemap integrity

- Area: seo
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: Search engines receive only valid canonical pages.
- Exact expected behavior: Sitemap entries resolve, are canonical, and exclude drafts, aliases, and error pages.
- Primary evidence: structured-data — Retain machine-readable request and assertion evidence proving: Sitemap entries resolve, are canonical, and exclude drafts, aliases, and error pages.
- Single-site classification: standalone-compatible — default oracle `SEO-002:standalone`
- Evidence attachments: `network`, `json`
- Owning plugins: `platform-routes-content`

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/contracts.spec.ts` | `candidate-chromium-projects` | `comparative`, `single-site` | `comparative: SEO-002:comparative`, `singleSite: SEO-002:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium`, `candidate-mobile-chromium-pixel-10-android16`, `candidate-mobile-chromium-pixel-8-android14`, `candidate-mobile-chromium-galaxy-s24-android14`, `candidate-desktop-chromium-edge-compat`, `candidate-desktop-chromium-msedge` |

### DEVICE-001 — Real iPhone Safari acceptance

- Area: responsive
- Severity and gate: P0; release blocking
- Execution: manual evidence and attestation required
- User promise: The launch works in the browser used by many mobile readers.
- Exact expected behavior: Critical journeys pass on current and small-screen physical iPhones.
- Primary evidence: interaction-video — Complete critical tap, navigation, form, and scroll journeys on physical iPhone Safari.
- Single-site classification: standalone-compatible — default oracle `DEVICE-001:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

Manual coverage has no automated source case; the long checklist remains incomplete until a reviewer attaches and attests valid evidence.

### DEVICE-002 — Real Android Chrome acceptance

- Area: responsive
- Severity and gate: P0; release blocking
- Execution: manual evidence and attestation required
- User promise: The launch works on representative physical Android hardware.
- Exact expected behavior: Critical journeys pass on a current physical Pixel or Samsung device.
- Primary evidence: interaction-video — Complete critical tap, navigation, form, and scroll journeys on physical Android Chrome.
- Single-site classification: standalone-compatible — default oracle `DEVICE-002:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

Manual coverage has no automated source case; the long checklist remains incomplete until a reviewer attaches and attests valid evidence.

### DEVICE-003 — Real iPad Safari acceptance

- Area: responsive
- Severity and gate: P1; release blocking
- Execution: manual evidence and attestation required
- User promise: Tablet readers receive a deliberate layout rather than a stretched phone page.
- Exact expected behavior: Critical journeys pass in portrait and landscape on a physical iPad.
- Primary evidence: interaction-video — Complete critical touch and rotation journeys on a physical iPad in both orientations.
- Single-site classification: standalone-compatible — default oracle `DEVICE-003:standalone`
- Evidence attachments: `video`, `json`
- Owning plugins: `accessibility-responsive-performance-reliability`

Manual coverage has no automated source case; the long checklist remains incomplete until a reviewer attaches and attests valid evidence.

### PAGE-HOME — Page audit: /

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-HOME:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-HOME:comparative`, `singleSite: PAGE-HOME:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-BRAND — Page audit: /brand

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-BRAND:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-BRAND:comparative`, `singleSite: PAGE-BRAND:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-NEXT-KRATOM-SUPPORT-MEETING — Page audit: /next-kratom-support-meeting

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-NEXT-KRATOM-SUPPORT-MEETING:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-NEXT-KRATOM-SUPPORT-MEETING:comparative`, `singleSite: PAGE-NEXT-KRATOM-SUPPORT-MEETING:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-SEARCH — Page audit: /search

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-SEARCH:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `candidate-full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-SEARCH:comparative`, `singleSite: PAGE-SEARCH:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-SITEMAP — Page audit: /sitemap

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-SITEMAP:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-SITEMAP:comparative`, `singleSite: PAGE-SITEMAP:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-VIRTUAL-NA-MEETINGS-NOW — Page audit: /virtual-na-meetings-now

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-VIRTUAL-NA-MEETINGS-NOW:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-VIRTUAL-NA-MEETINGS-NOW:comparative`, `singleSite: PAGE-VIRTUAL-NA-MEETINGS-NOW:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-VIRTUAL-SMART-MEETINGS-NOW — Page audit: /virtual-smart-meetings-now

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-VIRTUAL-SMART-MEETINGS-NOW:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-VIRTUAL-SMART-MEETINGS-NOW:comparative`, `singleSite: PAGE-VIRTUAL-SMART-MEETINGS-NOW:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-ABOUT — Page audit: /about

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-ABOUT:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-ABOUT:comparative`, `singleSite: PAGE-ABOUT:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS — Page audit: /compounds

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS:comparative`, `singleSite: PAGE-COMPOUNDS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES — Page audit: /for-loved-ones

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES:comparative`, `singleSite: PAGE-FOR-LOVED-ONES:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU — Page audit: /for-you

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU:comparative`, `singleSite: PAGE-FOR-YOU:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE — Page audit: /mat-suboxone

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE:comparative`, `singleSite: PAGE-MAT-SUBOXONE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS — Page audit: /medications-supplements

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-PHARMACOLOGY — Page audit: /pharmacology

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-PHARMACOLOGY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-PHARMACOLOGY:comparative`, `singleSite: PAGE-PHARMACOLOGY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE — Page audit: /post-acute

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE:comparative`, `singleSite: PAGE-POST-ACUTE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES — Page audit: /resources

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES:comparative`, `singleSite: PAGE-RESOURCES:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE — Page audit: /start-here

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE:comparative`, `singleSite: PAGE-START-HERE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-ABOUT-ACKNOWLEDGMENTS — Page audit: /about/acknowledgments

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-ABOUT-ACKNOWLEDGMENTS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `candidate-full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-ABOUT-ACKNOWLEDGMENTS:comparative`, `singleSite: PAGE-ABOUT-ACKNOWLEDGMENTS:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-ABOUT-CHANGELOG — Page audit: /about/changelog

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-ABOUT-CHANGELOG:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-ABOUT-CHANGELOG:comparative`, `singleSite: PAGE-ABOUT-CHANGELOG:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-ABOUT-CONTRIBUTING — Page audit: /about/contributing

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-ABOUT-CONTRIBUTING:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-ABOUT-CONTRIBUTING:comparative`, `singleSite: PAGE-ABOUT-CONTRIBUTING:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-ABOUT-SITE-ARCHITECTURE — Page audit: /about/site-architecture

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-ABOUT-SITE-ARCHITECTURE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `candidate-full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-ABOUT-SITE-ARCHITECTURE:comparative`, `singleSite: PAGE-ABOUT-SITE-ARCHITECTURE:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-ABOUT-THE-COMMUNITY — Page audit: /about/the-community

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-ABOUT-THE-COMMUNITY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-ABOUT-THE-COMMUNITY:comparative`, `singleSite: PAGE-ABOUT-THE-COMMUNITY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-ABOUT-THIS-SITE — Page audit: /about/this-site

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-ABOUT-THIS-SITE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-ABOUT-THIS-SITE:comparative`, `singleSite: PAGE-ABOUT-THIS-SITE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-ABOUT-WHERE-WE-STAND — Page audit: /about/where-we-stand

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-ABOUT-WHERE-WE-STAND:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-ABOUT-WHERE-WE-STAND:comparative`, `singleSite: PAGE-ABOUT-WHERE-WE-STAND:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS-7-OH-BAN — Page audit: /compounds/7-oh-ban

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS-7-OH-BAN:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS-7-OH-BAN:comparative`, `singleSite: PAGE-COMPOUNDS-7-OH-BAN:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS-7-OH — Page audit: /compounds/7-oh

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS-7-OH:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS-7-OH:comparative`, `singleSite: PAGE-COMPOUNDS-7-OH:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS-CATS-CLAW — Page audit: /compounds/cats-claw

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS-CATS-CLAW:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS-CATS-CLAW:comparative`, `singleSite: PAGE-COMPOUNDS-CATS-CLAW:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS-KRATOM-LEAF — Page audit: /compounds/kratom-leaf

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS-KRATOM-LEAF:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS-KRATOM-LEAF:comparative`, `singleSite: PAGE-COMPOUNDS-KRATOM-LEAF:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS-MGM15 — Page audit: /compounds/mgm15

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS-MGM15:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS-MGM15:comparative`, `singleSite: PAGE-COMPOUNDS-MGM15:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS-MGM16 — Page audit: /compounds/mgm16

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS-MGM16:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS-MGM16:comparative`, `singleSite: PAGE-COMPOUNDS-MGM16:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS-MIT-A-DHM — Page audit: /compounds/mit-a-dhm

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS-MIT-A-DHM:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS-MIT-A-DHM:comparative`, `singleSite: PAGE-COMPOUNDS-MIT-A-DHM:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-COMPOUNDS-MITRAGYNINE-PSEUDOINDOXYL — Page audit: /compounds/mitragynine-pseudoindoxyl

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-COMPOUNDS-MITRAGYNINE-PSEUDOINDOXYL:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-COMPOUNDS-MITRAGYNINE-PSEUDOINDOXYL:comparative`, `singleSite: PAGE-COMPOUNDS-MITRAGYNINE-PSEUDOINDOXYL:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-ASKING-THEM-TO-LEAVE — Page audit: /for-loved-ones/asking-them-to-leave

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-ASKING-THEM-TO-LEAVE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-ASKING-THEM-TO-LEAVE:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-ASKING-THEM-TO-LEAVE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-AT-HOME-RECOVERY — Page audit: /for-loved-ones/at-home-recovery

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-AT-HOME-RECOVERY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-AT-HOME-RECOVERY:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-AT-HOME-RECOVERY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-BOUNDARIES — Page audit: /for-loved-ones/boundaries

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-BOUNDARIES:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-BOUNDARIES:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-BOUNDARIES:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-FMLA-WORKPLACE — Page audit: /for-loved-ones/fmla-workplace

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-FMLA-WORKPLACE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-FMLA-WORKPLACE:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-FMLA-WORKPLACE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-HOW-TO-TALK — Page audit: /for-loved-ones/how-to-talk

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-HOW-TO-TALK:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-HOW-TO-TALK:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-HOW-TO-TALK:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-REHABILITATION-CENTERS — Page audit: /for-loved-ones/rehabilitation-centers

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-REHABILITATION-CENTERS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-REHABILITATION-CENTERS:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-REHABILITATION-CENTERS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-SAFETY — Page audit: /for-loved-ones/safety

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-SAFETY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-SAFETY:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-SAFETY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-SUPPORT-GROUPS — Page audit: /for-loved-ones/support-groups

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-SUPPORT-GROUPS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-SUPPORT-GROUPS:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-SUPPORT-GROUPS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-TAKING-CARE-OF-YOURSELF — Page audit: /for-loved-ones/taking-care-of-yourself

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-TAKING-CARE-OF-YOURSELF:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-TAKING-CARE-OF-YOURSELF:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-TAKING-CARE-OF-YOURSELF:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-WELCOME — Page audit: /for-loved-ones/welcome

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-WELCOME:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-WELCOME:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-WELCOME:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-LOVED-ONES-WHAT-TO-EXPECT — Page audit: /for-loved-ones/what-to-expect

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-LOVED-ONES-WHAT-TO-EXPECT:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-LOVED-ONES-WHAT-TO-EXPECT:comparative`, `singleSite: PAGE-FOR-LOVED-ONES-WHAT-TO-EXPECT:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU-AT-HOME-TREATMENT — Page audit: /for-you/at-home-treatment

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU-AT-HOME-TREATMENT:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU-AT-HOME-TREATMENT:comparative`, `singleSite: PAGE-FOR-YOU-AT-HOME-TREATMENT:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU-FMLA-ADA-JOB — Page audit: /for-you/fmla-ada-job

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU-FMLA-ADA-JOB:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU-FMLA-ADA-JOB:comparative`, `singleSite: PAGE-FOR-YOU-FMLA-ADA-JOB:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU-MAT-AND-YOUR-JOB — Page audit: /for-you/mat-and-your-job

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU-MAT-AND-YOUR-JOB:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU-MAT-AND-YOUR-JOB:comparative`, `singleSite: PAGE-FOR-YOU-MAT-AND-YOUR-JOB:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU-MUTUAL-AID — Page audit: /for-you/mutual-aid

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU-MUTUAL-AID:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU-MUTUAL-AID:comparative`, `singleSite: PAGE-FOR-YOU-MUTUAL-AID:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU-REHABILITATION-CENTERS — Page audit: /for-you/rehabilitation-centers

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU-REHABILITATION-CENTERS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU-REHABILITATION-CENTERS:comparative`, `singleSite: PAGE-FOR-YOU-REHABILITATION-CENTERS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU-SOBER-LIVING — Page audit: /for-you/sober-living

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU-SOBER-LIVING:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU-SOBER-LIVING:comparative`, `singleSite: PAGE-FOR-YOU-SOBER-LIVING:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU-TAPERING-7OH — Page audit: /for-you/tapering-7oh

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU-TAPERING-7OH:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU-TAPERING-7OH:comparative`, `singleSite: PAGE-FOR-YOU-TAPERING-7OH:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-FOR-YOU-WELCOME — Page audit: /for-you/welcome

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-FOR-YOU-WELCOME:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-FOR-YOU-WELCOME:comparative`, `singleSite: PAGE-FOR-YOU-WELCOME:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE-LONG-TERM-SUBOXONE-RISKS — Page audit: /mat-suboxone/long-term-suboxone-risks

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE-LONG-TERM-SUBOXONE-RISKS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE-LONG-TERM-SUBOXONE-RISKS:comparative`, `singleSite: PAGE-MAT-SUBOXONE-LONG-TERM-SUBOXONE-RISKS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE-SOWS-COWS-INDUCTION-GUIDE — Page audit: /mat-suboxone/sows-cows-induction-guide

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE-SOWS-COWS-INDUCTION-GUIDE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE-SOWS-COWS-INDUCTION-GUIDE:comparative`, `singleSite: PAGE-MAT-SUBOXONE-SOWS-COWS-INDUCTION-GUIDE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE-SUBLOCADE-BRIXADI — Page audit: /mat-suboxone/sublocade-brixadi

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE-SUBLOCADE-BRIXADI:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE-SUBLOCADE-BRIXADI:comparative`, `singleSite: PAGE-MAT-SUBOXONE-SUBLOCADE-BRIXADI:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE-SUBOXONE-BERNESE-METHOD — Page audit: /mat-suboxone/suboxone-bernese-method

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE-SUBOXONE-BERNESE-METHOD:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE-SUBOXONE-BERNESE-METHOD:comparative`, `singleSite: PAGE-MAT-SUBOXONE-SUBOXONE-BERNESE-METHOD:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE-SUBOXONE-CUSTOM-DOSE — Page audit: /mat-suboxone/suboxone-custom-dose

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE-SUBOXONE-CUSTOM-DOSE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE-SUBOXONE-CUSTOM-DOSE:comparative`, `singleSite: PAGE-MAT-SUBOXONE-SUBOXONE-CUSTOM-DOSE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE-SUBOXONE-FOR-7OH — Page audit: /mat-suboxone/suboxone-for-7oh

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE-SUBOXONE-FOR-7OH:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE-SUBOXONE-FOR-7OH:comparative`, `singleSite: PAGE-MAT-SUBOXONE-SUBOXONE-FOR-7OH:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE-SUBOXONE-RAPID-TAPER — Page audit: /mat-suboxone/suboxone-rapid-taper

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE-SUBOXONE-RAPID-TAPER:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE-SUBOXONE-RAPID-TAPER:comparative`, `singleSite: PAGE-MAT-SUBOXONE-SUBOXONE-RAPID-TAPER:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MAT-SUBOXONE-WHY-SUBOXONE-ISNT-WORKING — Page audit: /mat-suboxone/why-suboxone-isnt-working

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MAT-SUBOXONE-WHY-SUBOXONE-ISNT-WORKING:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MAT-SUBOXONE-WHY-SUBOXONE-ISNT-WORKING:comparative`, `singleSite: PAGE-MAT-SUBOXONE-WHY-SUBOXONE-ISNT-WORKING:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-CANNABIS-THC-IN-RECOVERY — Page audit: /medications-supplements/cannabis-thc-in-recovery

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-CANNABIS-THC-IN-RECOVERY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-CANNABIS-THC-IN-RECOVERY:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-CANNABIS-THC-IN-RECOVERY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-HELPER-MEDS — Page audit: /medications-supplements/helper-meds

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-HELPER-MEDS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-HELPER-MEDS:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-HELPER-MEDS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-MEGA-DOSE-VITAMIN-C — Page audit: /medications-supplements/mega-dose-vitamin-c

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-MEGA-DOSE-VITAMIN-C:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-MEGA-DOSE-VITAMIN-C:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-MEGA-DOSE-VITAMIN-C:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-NAD-IV-THERAPY — Page audit: /medications-supplements/nad-iv-therapy

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-NAD-IV-THERAPY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-NAD-IV-THERAPY:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-NAD-IV-THERAPY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-PEPTIDES-FOR-WITHDRAWAL — Page audit: /medications-supplements/peptides-for-withdrawal

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-PEPTIDES-FOR-WITHDRAWAL:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-PEPTIDES-FOR-WITHDRAWAL:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-PEPTIDES-FOR-WITHDRAWAL:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-7-OH-WITH-KRATOM-LEAF — Page audit: /medications-supplements/quit-7-oh-with-kratom-leaf

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-7-OH-WITH-KRATOM-LEAF:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-7-OH-WITH-KRATOM-LEAF:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-7-OH-WITH-KRATOM-LEAF:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-7-OH-WITH-MITRAGYNINE — Page audit: /medications-supplements/quit-7-oh-with-mitragynine

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-7-OH-WITH-MITRAGYNINE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-7-OH-WITH-MITRAGYNINE:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-7-OH-WITH-MITRAGYNINE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-KIT — Page audit: /medications-supplements/quit-kit

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-KIT:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-KIT:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-QUIT-KIT:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-SR-17 — Page audit: /medications-supplements/sr-17

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-SR-17:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-SR-17:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-SR-17:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-MEDICATIONS-SUPPLEMENTS-VITAMINS-SUPPLEMENTS — Page audit: /medications-supplements/vitamins-supplements

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-MEDICATIONS-SUPPLEMENTS-VITAMINS-SUPPLEMENTS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-MEDICATIONS-SUPPLEMENTS-VITAMINS-SUPPLEMENTS:comparative`, `singleSite: PAGE-MEDICATIONS-SUPPLEMENTS-VITAMINS-SUPPLEMENTS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-PHARMACOLOGY-CHEMICAL-STRUCTURES — Page audit: /pharmacology/chemical-structures

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-PHARMACOLOGY-CHEMICAL-STRUCTURES:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-PHARMACOLOGY-CHEMICAL-STRUCTURES:comparative`, `singleSite: PAGE-PHARMACOLOGY-CHEMICAL-STRUCTURES:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-PHARMACOLOGY-KRATOM-MINOR-ALKALOIDS — Page audit: /pharmacology/kratom-minor-alkaloids

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-PHARMACOLOGY-KRATOM-MINOR-ALKALOIDS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-PHARMACOLOGY-KRATOM-MINOR-ALKALOIDS:comparative`, `singleSite: PAGE-PHARMACOLOGY-KRATOM-MINOR-ALKALOIDS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-PHARMACOLOGY-MORPHINE-VS-KRATOM — Page audit: /pharmacology/morphine-vs-kratom

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-PHARMACOLOGY-MORPHINE-VS-KRATOM:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-PHARMACOLOGY-MORPHINE-VS-KRATOM:comparative`, `singleSite: PAGE-PHARMACOLOGY-MORPHINE-VS-KRATOM:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-7-OH-RECOVERY-TIMELINE — Page audit: /post-acute/7-oh-recovery-timeline

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-7-OH-RECOVERY-TIMELINE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-7-OH-RECOVERY-TIMELINE:comparative`, `singleSite: PAGE-POST-ACUTE-7-OH-RECOVERY-TIMELINE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-DEPRESSION-AND-ANHEDONIA — Page audit: /post-acute/depression-and-anhedonia

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-DEPRESSION-AND-ANHEDONIA:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-DEPRESSION-AND-ANHEDONIA:comparative`, `singleSite: PAGE-POST-ACUTE-DEPRESSION-AND-ANHEDONIA:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-DOPAMINE-RECOVERY — Page audit: /post-acute/dopamine-recovery

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-DOPAMINE-RECOVERY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-DOPAMINE-RECOVERY:comparative`, `singleSite: PAGE-POST-ACUTE-DOPAMINE-RECOVERY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-ENDOCRINE-RECOVERY — Page audit: /post-acute/endocrine-recovery

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-ENDOCRINE-RECOVERY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-ENDOCRINE-RECOVERY:comparative`, `singleSite: PAGE-POST-ACUTE-ENDOCRINE-RECOVERY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-IMPENDING-DOOM-ANXIETY — Page audit: /post-acute/impending-doom-anxiety

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-IMPENDING-DOOM-ANXIETY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-IMPENDING-DOOM-ANXIETY:comparative`, `singleSite: PAGE-POST-ACUTE-IMPENDING-DOOM-ANXIETY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-KINDLING-AND-RELAPSE — Page audit: /post-acute/kindling-and-relapse

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-KINDLING-AND-RELAPSE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-KINDLING-AND-RELAPSE:comparative`, `singleSite: PAGE-POST-ACUTE-KINDLING-AND-RELAPSE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-NALTREXONE-LOW-DOSE — Page audit: /post-acute/naltrexone-low-dose

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-NALTREXONE-LOW-DOSE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-NALTREXONE-LOW-DOSE:comparative`, `singleSite: PAGE-POST-ACUTE-NALTREXONE-LOW-DOSE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-NALTREXONE-NORMAL-DOSE — Page audit: /post-acute/naltrexone-normal-dose

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-NALTREXONE-NORMAL-DOSE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-NALTREXONE-NORMAL-DOSE:comparative`, `singleSite: PAGE-POST-ACUTE-NALTREXONE-NORMAL-DOSE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-NALTREXONE-ULTRA-LOW-DOSE — Page audit: /post-acute/naltrexone-ultra-low-dose

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-NALTREXONE-ULTRA-LOW-DOSE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-NALTREXONE-ULTRA-LOW-DOSE:comparative`, `singleSite: PAGE-POST-ACUTE-NALTREXONE-ULTRA-LOW-DOSE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-NALTREXONE — Page audit: /post-acute/naltrexone

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-NALTREXONE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-NALTREXONE:comparative`, `singleSite: PAGE-POST-ACUTE-NALTREXONE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-PAWS-POST-ACUTE-WITHDRAWAL — Page audit: /post-acute/paws-post-acute-withdrawal

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-PAWS-POST-ACUTE-WITHDRAWAL:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-PAWS-POST-ACUTE-WITHDRAWAL:comparative`, `singleSite: PAGE-POST-ACUTE-PAWS-POST-ACUTE-WITHDRAWAL:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-PINK-CLOUD — Page audit: /post-acute/pink-cloud

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-PINK-CLOUD:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-PINK-CLOUD:comparative`, `singleSite: PAGE-POST-ACUTE-PINK-CLOUD:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-POST-ACUTE-SLEEP-RECOVERY — Page audit: /post-acute/sleep-recovery

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-POST-ACUTE-SLEEP-RECOVERY:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-POST-ACUTE-SLEEP-RECOVERY:comparative`, `singleSite: PAGE-POST-ACUTE-SLEEP-RECOVERY:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-7-OH-TAPER-CALCULATOR — Page audit: /resources/7-oh-taper-calculator

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-7-OH-TAPER-CALCULATOR:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-7-OH-TAPER-CALCULATOR:comparative`, `singleSite: PAGE-RESOURCES-7-OH-TAPER-CALCULATOR:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-CRISIS-HOTLINES — Page audit: /resources/crisis-hotlines

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-CRISIS-HOTLINES:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-CRISIS-HOTLINES:comparative`, `singleSite: PAGE-RESOURCES-CRISIS-HOTLINES:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-KRATOM-LEAF-TAPER-CALCULATOR — Page audit: /resources/kratom-leaf-taper-calculator

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-KRATOM-LEAF-TAPER-CALCULATOR:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-KRATOM-LEAF-TAPER-CALCULATOR:comparative`, `singleSite: PAGE-RESOURCES-KRATOM-LEAF-TAPER-CALCULATOR:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-MEETING-SCHEDULES — Page audit: /resources/meeting-schedules

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-MEETING-SCHEDULES:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-MEETING-SCHEDULES:comparative`, `singleSite: PAGE-RESOURCES-MEETING-SCHEDULES:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-RECOVERY-COACHING — Page audit: /resources/recovery-coaching

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-RECOVERY-COACHING:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-RECOVERY-COACHING:comparative`, `singleSite: PAGE-RESOURCES-RECOVERY-COACHING:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-SR-17-TAPER-CALCULATOR — Page audit: /resources/sr-17-taper-calculator

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-SR-17-TAPER-CALCULATOR:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-SR-17-TAPER-CALCULATOR:comparative`, `singleSite: PAGE-RESOURCES-SR-17-TAPER-CALCULATOR:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-SUBOXONE-TAPER-CALCULATOR — Page audit: /resources/suboxone-taper-calculator

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-SUBOXONE-TAPER-CALCULATOR:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-SUBOXONE-TAPER-CALCULATOR:comparative`, `singleSite: PAGE-RESOURCES-SUBOXONE-TAPER-CALCULATOR:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-TAPER-CALCULATOR — Page audit: /resources/taper-calculator

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-TAPER-CALCULATOR:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-TAPER-CALCULATOR:comparative`, `singleSite: PAGE-RESOURCES-TAPER-CALCULATOR:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-RESOURCES-TELEHEALTH-FOR-SUBOXONE — Page audit: /resources/telehealth-for-suboxone

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-RESOURCES-TELEHEALTH-FOR-SUBOXONE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-RESOURCES-TELEHEALTH-FOR-SUBOXONE:comparative`, `singleSite: PAGE-RESOURCES-TELEHEALTH-FOR-SUBOXONE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE-7-OH-WITHDRAWAL-GUIDE — Page audit: /start-here/7-oh-withdrawal-guide

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE-7-OH-WITHDRAWAL-GUIDE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `candidate-full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE-7-OH-WITHDRAWAL-GUIDE:comparative`, `singleSite: PAGE-START-HERE-7-OH-WITHDRAWAL-GUIDE:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE-7-OH-WITHDRAWAL-HELP — Page audit: /start-here/7-oh-withdrawal-help

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE-7-OH-WITHDRAWAL-HELP:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE-7-OH-WITHDRAWAL-HELP:comparative`, `singleSite: PAGE-START-HERE-7-OH-WITHDRAWAL-HELP:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE-7-OH-WITHDRAWAL-QUICKSTART — Page audit: /start-here/7-oh-withdrawal-quickstart

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE-7-OH-WITHDRAWAL-QUICKSTART:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `candidate-full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE-7-OH-WITHDRAWAL-QUICKSTART:comparative`, `singleSite: PAGE-START-HERE-7-OH-WITHDRAWAL-QUICKSTART:standalone` | `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE-CRAVINGS-AND-RELAPSE-THOUGHTS — Page audit: /start-here/cravings-and-relapse-thoughts

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE-CRAVINGS-AND-RELAPSE-THOUGHTS:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE-CRAVINGS-AND-RELAPSE-THOUGHTS:comparative`, `singleSite: PAGE-START-HERE-CRAVINGS-AND-RELAPSE-THOUGHTS:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE-HOW-TO-QUIT-7-OH — Page audit: /start-here/how-to-quit-7-oh

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE-HOW-TO-QUIT-7-OH:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE-HOW-TO-QUIT-7-OH:comparative`, `singleSite: PAGE-START-HERE-HOW-TO-QUIT-7-OH:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE-HOW-TO-USE-THIS-WEBSITE — Page audit: /start-here/how-to-use-this-website

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE-HOW-TO-USE-THIS-WEBSITE:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE-HOW-TO-USE-THIS-WEBSITE:comparative`, `singleSite: PAGE-START-HERE-HOW-TO-USE-THIS-WEBSITE:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE-WELCOME — Page audit: /start-here/welcome

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE-WELCOME:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE-WELCOME:comparative`, `singleSite: PAGE-START-HERE-WELCOME:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |

### PAGE-START-HERE-WHAT-IS-7-OH — Page audit: /start-here/what-is-7-oh

- Area: routes
- Severity and gate: P1; release blocking
- Execution: automated; assertion-quality gate required
- User promise: This published destination renders completely and remains usable.
- Exact expected behavior: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Primary evidence: static-screenshot — Capture the rendered state and structured evidence proving: The exact route returns valid HTML with matching page identity, substantive route-specific content, one H1, metadata, loaded images, diagnosed overflow, and no runtime failures.
- Single-site classification: standalone-compatible — default oracle `PAGE-START-HERE-WHAT-IS-7-OH:standalone`
- Evidence attachments: `screenshot`, `network`, `axe`, `json`
- Owning plugins: `platform-routes-content` (generated from the reviewed route inventory)

| Source test | Applicability | Run modes | Product Oracle variants | Executable browser/device targets |
| --- | --- | --- | --- | --- |
| `tests/page-audit.spec.ts` | `full-sweep-projects` | `comparative`, `single-site` | `comparative: PAGE-START-HERE-WHAT-IS-7-OH:comparative`, `singleSite: PAGE-START-HERE-WHAT-IS-7-OH:standalone` | `production-mobile-chromium`, `candidate-mobile-chromium`, `candidate-desktop-chromium` |
