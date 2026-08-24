# End-to-end redesign test plan

## Goal

Find visual, behavioral, content, accessibility, reliability, and release-engineering defects before the redesigned quitting7oh.org replaces production. Production is evidence about the current reader experience; the beta is the launch candidate. Existing production defects remain visible as baseline findings, while the release decision is driven by candidate failures and explicit cross-environment migration/parity contracts.

## Test layers

1. **Environment contracts** verify HTTPS, response types, redirects, cache/security headers, data endpoints, canonical and robots intent, sitemap coverage, static assets, and custom error behavior.
2. **Complete page inventory** opens every published candidate route in the full-sweep projects and records H1/metadata/image/overflow/runtime evidence plus top, middle, and bottom viewport screenshots for scrollable candidate documents.
3. **Paired visual evidence** captures representative production and candidate templates at matching mobile and desktop viewports. Candidate snapshot baselines catch subsequent pixel regressions; documents beyond the browser's safe full-page limit use five distributed viewport baselines per theme so the middle is not omitted. The checklist makes intentional redesign differences distinguishable from missing content.
4. **Feature journeys** exercise real interactions rather than merely loading pages: navigation, search, themes, calculators, SOWS, meetings, clipboard/print, storage, failures, and recovery actions.
5. **Cross-browser and responsive coverage** runs Chromium, WebKit, and Firefox over phone, tablet, and desktop profiles, with explicit tests on both sides of custom breakpoints.
6. **Accessibility and performance** use axe, keyboard journeys, reduced motion, reflow/manual rows, resource budgets, and measured layout-shift evidence.
7. **Human acceptance** preserves real iPhone, Android, iPad, VoiceOver, and visual-design review as manual rows. They cannot be silently promoted to automated passes.

## Evidence contract

Every automated test title includes a stable audit ID. The test fixture emits a structured `audit-result` attachment containing:

- environment, origin, browser/project, viewport, timezone, and timestamps;
- named steps with the expected outcome and pass/fail detail;
- concrete observations and release findings;
- inspected page dimensions, metadata, broken images, and overflow;
- first-party HTTP response codes/content types, failures, and bad responses;
- console errors/warnings and uncaught page errors.

The generated assertion ledger maps all 81 feature and cross-cutting contracts and all 102 route-specific contracts to their product promise, exact expected behavior, executable source, applicability, target matrix, and evidence policy. The assertion-quality validation gate parses every enabled declaration and rejects tautologies, self-comparisons, swallowed promise failures, conditional-only or observation-only checks, missing automated cases, placeholder contracts, and any P0/P1 definition that is not release blocking. Mutation canaries prove those rejection paths are live. A test is not considered meaningful merely because Playwright can execute it or because its current page happens to pass.

Release-profile video is on only for tests explicitly declared as `interaction-video`. Each declaration states the user action and observable response that the clip demonstrates; setup navigation by itself never qualifies. Rendered static checks require an actual checkpoint screenshot of the state under assertion. Pure request, redirect, sitemap, and data-contract checks use `structured-data` and produce no decorative media. Traces are retained on failure. The reporter evaluates required media per execution, so a mixed audit such as A11Y-001 can require screenshots for page scans and video for its opened-dialog interaction. Missing or mismatched policy evidence prevents `PASS`.

Every executed interaction must put its observable user action and response assertion inside a named `audit.step`. The interaction-only fixture gives the loaded starting state a 700 ms establishing beat, holds 200 ms before each labeled action, holds its response for 450 ms, and leaves the final outcome visible for 1.1 seconds. Playwright overlays the current test/step and pointer action in the recording, so a reviewer can tell what happened and what the clip is proving without relying on the filename. A legitimate popup that proves an outcome (such as a printable plan or external meeting destination) is asserted and held for 2.2 seconds before closing. Hidden `about:blank` tooling pages are never held, so helper recordings do not masquerade as interaction evidence. These waits are bounded and resolve to zero for static-screenshot and structured-data checks. Validation rejects a passing interaction with no labeled action/response step.

Playwright can start a recording context before a project-specific `test.skip` decision runs. The post-run media gate therefore reconciles every recording against `results.json`: a video is retained only when its exact attachment hash belongs to a non-skipped attempt with an explicit `interaction-video` policy. Failed and timed-out interaction attempts are retained because they show the defect. Skipped, static, structured, unannotated, and orphan generated recordings are removed from raw shard output, merged blob resources, HTML-report data, and generated checklist copies. Sibling generated posters are removed with rejected clips. Reviewer uploads beneath `manual-evidence/` are never pruned. In the release profile, a missing video for an executed interaction is an evidence-integrity failure, not a green result; smoke retains interaction video only on failure and does not require clips from passing attempts.

An interaction attempt can also create hidden helper pages. For example, accessibility tooling may open a short `about:blank` page, causing Playwright to attach a second, visually empty recording beside the real interaction. The media gate probes every otherwise-eligible clip with FFmpeg. A usable action clip must be at least two seconds long, decode multiple representative frames, contain informative frame content, and show measurable frame-to-frame visual change. Informative content is range-independent: the gate measures sampled luma spread, so solid white in studio or full range, black, gray, and uniformly tinted frames cannot pass merely because their absolute brightness differs. A bounded leading capture gap can be trimmed only into a new derivative: the original must end in sustained content and contain a separate change after real content has settled, and the derivative must independently pass the full duration, blank-ratio, initial/final-content, decode, and action checks. This prevents a delayed page paint from impersonating a user interaction while rescuing real action/response evidence that starts with Playwright capture white. Mutation canaries cover transient overlay-to-white, transient overlay-to-black, all-white, blank-ending, delayed-paint-only, legitimate low-motion, and leading-blank-then-action cases. Short blank/static, corrupt, or undecodable helper clips are removed by exact hash from every generated copy and deleted from the normalized `results.json` attachment list before the checklist is rebuilt. A shorter clip from a failed or timed-out interaction is preserved only when it decodes and shows measurable visual change, because an immediate failure can be useful diagnostic evidence; it remains explicitly non-release evidence and cannot satisfy the attempt's duration gate. The attempt passes the media gate when a legitimate primary clip remains; an executed interaction with only helper-quality or diagnostic-only short clips fails evidence integrity in every profile.

## Profiles

### Smoke

Use for environment and portal validation. It checks availability, candidate routing/indexing/security/data contracts, starting paths, crisis help, and runtime health on the selected projects. It is intentionally short enough to run after infrastructure or content deployment.

### Release

Use for go-live. It records purposeful interaction videos, screenshot evidence for static rendered states, structured request/data contracts, all-route coverage, feature journeys, failure simulations, visual baselines, accessibility/performance checks, and visible physical-device/manual work. In the recommended sharded topology, functional and visual work is parallelized first; Lighthouse and browser performance then run alone in a one-worker container before every fresh blob is merged into the same release checklist.

## Browser and device coverage model

The seven established Playwright projects remain the default release matrix. Additional iPhone/iOS-user-agent WebKit, Pixel/Android Chromium, Galaxy/Android Chromium, and Edge profiles are opt-in through the validated `AUDIT_TARGET_IDS` registry. Selecting extra targets is an intentional scope decision recorded by the project names; it never happens merely because a registry entry was added.

Evidence labels describe what ran. A Playwright device descriptor emulates viewport, scale, touch, and user agent on desktop WebKit or Chromium. It is useful for responsive behavior and engine compatibility, but it is not iOS, Mobile Safari, Chrome for Android, OEM browser behavior, a radio/network stack, or physical hardware. Edge-compatible Chromium is also distinct from the optional branded Microsoft Edge channel. The test plan must not use an emulated pass to close a real-device checklist row.

The target catalog contains provider-ready metadata for current and previous real iOS Safari and Android Chrome, but those rows are non-runnable until an installed adapter provides authenticated real-device sessions, artifact retrieval, and trustworthy run provenance. Attempting to select one fails before execution. This leaves a clean extension point without manufacturing coverage that did not occur.

## Pass and release rules

- `P0`: launch blocker on the candidate or a required migration contract.
- `P1`: launch blocker unless a named owner records an explicit, time-bounded waiver.
- `P2`: fix before launch when practical; otherwise assign an owner and follow-up date.
- `P3`: improvement opportunity.
- A deterministic test failure cannot be overridden by AI output.
- A production-baseline-only failure is context, not by itself a candidate launch blocker.
- Missing required evidence prevents `PASS`.
- `NOT RUN` and `MANUAL` are never equivalent to pass.
- Flaky/retried checks stay visible and require triage; a retry is evidence, not erasure.
- TLS verification is strict for release evidence. A recorded candidate development bypass may collect debugging evidence, but every affected candidate execution becomes `REVIEW` and the checklist cannot be `READY`.
- A portal-launched release is a single-container review run. Its checklist decision is preserved, but a `READY` checklist is never presented as final authority. Go-live signoff requires a fresh `audit:release:sharded` run ID with fresh functional blobs and isolated single-worker performance provenance.
- Manual media is accepted only after signature matching plus bounded FFprobe/FFmpeg visual-stream decoding. Uploads, attestations, and their rebuild are serialized per run; an invalid or concurrent submission cannot become passing evidence.

## Run review

Review the portal in this order:

1. confirm selected origins, profile, plugins/audits, and projects;
2. watch live logs for container, browser, response, and runtime problems;
3. inspect all candidate P0/P1 failures and their videos/traces first;
4. compare corresponding production evidence to distinguish regression from baseline;
5. inspect P2/P3 and incomplete/manual rows;
6. review advisory AI findings against source evidence;
7. complete physical device/screen-reader checks;
8. record owners, waivers, and final launch decision.

## Visual gallery acceptance

The gallery reviews logical test evidence, not storage copies. Posters, raw copies, rejected helper recordings, blank/static/short videos, and transient files never become primary items. Validated action-and-response recordings are videos; placement, typography, and other static visual assertions remain screenshots. A test retry/project/attempt keeps its own stable context even when media bytes are shared.

Portal and archive use the exact shared reducer, keyboard contract, responsive breakpoints, and CSS. Left/Right moves one item without wrapping; Up/Down moves test groups while preserving the closest local member; `[`/`]` changes comparison members; Space controls only a selected video while the viewer owns focus; `I`, `F`, Escape, and `?` control context, fullscreen, one-layer unwind, and help. Modified, editable, composing, dialog-owned, and native-media events are suppressed. Mobile controls are at least 44 × 44 CSS pixels, reduced motion removes nonessential animation, and focus returns to the opener after panels/dialogs close.

The exact reference fixture contains 5,659 artifacts, 1,241 logical media items, 110 validated videos, and 17,527 physically materialized corpus files. The harness writes and recounts every artifact href plus every modeled storage copy before measurement, then verifies every file's bytes against its catalog size and SHA-256; self-reported location counts are not accepted as proof. Descriptor/query wrappers are at most 256 KiB, details at most 512 KiB, pages at most 100 rows, and cold first-usable metadata at most 1 MiB over three requests. In the pinned 2-CPU/4-GiB Docker profile, five cold warmups precede 30 samples and ten transition warmups precede 100 samples. Release thresholds are p95 ≤2,000 ms cold, p95 ≤200 ms transition, ≤500 gallery DOM nodes, exactly one observed selected video, ≤25 MiB heap growth from two available finite positive CDP samples, and zero stale commits after 50 rapid superseding requests. A 151-change flag revision also proves that the client consumes every bounded delta page and exposes the new live flag facet before filtering.

The acceptance output must include raw timing JSON, the detected cgroup profile/methodology, Playwright results, a network trace, a portal workbench screenshot, an overview screenshot, a direct-file read-only archive screenshot, and an interaction video. The output directory is evidence-cleaned before each invocation and its current run-status record must say `passed`; a partial or failed invocation cannot reuse prior green files. A host run or an unconstrained container is diagnostic only.
