# Quitting7oh comparative and Single-site audit

This repository is a Docker-first visual and functional audit system. It supports a one-origin Single-site Audit and the established release comparison between:

- production baseline: `https://quitting7oh.org`
- redesigned candidate: `https://beta.quitting7oh-org.pages.dev`

It does not reduce a launch decision to a green check. Every audit has an ID, a reader-facing promise, explicit expected behavior, severity, release-blocking policy, performed steps, observed values, findings, and required evidence. Interaction tests record an action-and-response video with a human-readable rationale; rendered static checks capture relevant screenshots; request, redirect, sitemap, and other data-only contracts retain structured evidence without decorative media. FFmpeg rejects blank, static, and blank-ending recordings. A harmless leading browser-capture gap is trimmed only when the clip contains a later action after sustained page content and the derivative independently passes every quality gate. A run also retains traces, browser/network observations, Playwright results, a searchable long-form checklist, and an optional AI evidence review.

## Start the portal

Docker is the supported browser runtime, including on macOS. This command starts the portal, the durable Single-site worker pool, and the Single-site finalizer:

```sh
npm run portal
```

Open <http://127.0.0.1:4173>. Choose **Audit one site** to test one Preview or Production deployment without a comparison origin, or use the comparative launcher for the established production-versus-candidate release audit. The portal streams timestamped output from queue/start through browser execution, FFmpeg processing, report/gallery publication, optional AI review, and final disposition.

The portal is organized as a desktop administration console rather than a launch form with modal run details. `/` is a bounded Overview led by current Product Risk; Run Trust, active work, and the latest terminal run remain separate beside it. `/runs.html`, `/findings.html`, and `/evidence.html` are global, server-filtered indexes. `/new-audit.html` owns launch configuration, `/settings.html` owns credentials and runtime inventories, and `/run.html?mode=<mode>&run=<id>` is the stable live workspace from queue through finalization. Reports and galleries retain the same run identity and console navigation. An empty attention queue is never labelled as a pass, and a broken evidence pipeline is visible in Run Trust without erasing a product defect.

Safe filters, selections, inspector state, and run identity are addressable in the URL. Credentials, authorization, mutation bindings, and oversized or secret-like values are never URL or saved-view state. Every index response carries source revision, freshness, completeness, limitations, and bounded-work metadata; stale refreshes preserve the last sourced rows and say so explicitly. Purge invalidates matching rows, selections, media, live transports, and cached projections before the UI accepts completion.

For Single-site Audit, enter the site origin, explicitly confirm Preview or Production, and choose **Check site and preview coverage** before launch. That preflight is read-only: it verifies quitting7oh identity and previews the compiled Product Oracle and target coverage without creating a run. `FULL` means the complete versioned Single-site profile with no narrowing filters; selecting plugins, audit IDs, areas, or a target subset is `TARGETED`. A filtered run must never be described as whole-site coverage.

The Single-site report keeps separate truths separate:

- **Site Health** is `HEALTHY`, `FINDINGS`, or `INCOMPLETE` for the executed automated scope. It is advisory and never has promotion authority.
- **Coverage** is `COMPLETE`, `GAPS`, or `UNKNOWN`; a missing standalone oracle or executable case is visible rather than silently passing.
- **Manual acceptance** remains outstanding until a human supplies signed evidence. Automation and AI cannot turn it green.
- **Visual Review** reports `UNCHANGED` or `CHANGED` for compatible same-site baselines, with explicit absent, incompatible, and unavailable states. A reviewer can record an accepted-change or known-defect disposition to move an exact `CHANGED` comparison to `REVIEWED`; this append-only review record does not rewrite Site Health, Coverage, or deterministic Findings.
- **Evidence Authority** and Pipeline Integrity qualify all of the above. Preview certificate bypass is non-authoritative, and missing required evidence makes the run `INCOMPLETE`.

A portal-launched comparative release remains review evidence only: even a `READY` checklist is shown as **review required**, because the single-container launch has no canonical sharded/isolated-performance provenance. Final comparative signoff requires a new run ID with `npm run audit:release:sharded`. Every run has a plain-language report, searchable checklist, bounded log views, and evidence gallery. Comparative portal artifacts remain under `artifacts/runs/<run-id>/`; terminal sharded artifacts remain under `artifacts/sharded/<run-id>/`. Single-site jobs, immutable finalizations, and copied visual baselines live in separate Docker volumes so they survive container replacement.

Scale Single-site throughput across queued jobs with worker replicas (one job is claimed by one worker):

```sh
SINGLE_SITE_WORKER_REPLICAS=4 npm run portal
```

Completed, failed, and stopped runs can be permanently purged from their run detail view. The portal requires the reviewer to type `PURGE <run-id>` exactly, refuses active work and nested mounts, atomically moves the direct-child run into quarantine, and records the transaction in the root-only secret volume before recursive deletion. A restart therefore recovers any partial deletion as a visible `evidence-failed` record that accepts a safe retry. This applies to both portal-managed and terminal-launched sharded evidence. Keep release evidence that still needs sign-off or archival; purge cannot be undone.

Long actions are asynchronous: the portal stays interactive while run details, artifacts, reports, uploads, and saved settings load. Visible busy states, progress copy, disabled duplicate actions, and accessible live announcements make slow work explicit instead of looking frozen. The reviewer report never downloads the monolithic checklist manifest or a complete log: it uses a compact summary, server-filtered 25-row audit pages, one bounded detail record at a time, and a 64 KB log tail loaded only on request. The large raw checklist remains a download for offline analysis.

Do not use host-installed Playwright browsers as the normal execution path. The image pins the Playwright package and Microsoft browser image to the same version, providing consistent Chromium, Firefox, WebKit, system libraries, and FFmpeg behavior.

For the full sharded release, visual and functional checks default to eight functional shards with one Playwright worker each, scheduled through a bounded pool of four simultaneous Docker containers. This keeps the finer partitions without asking a typical Docker Desktop allocation to hold eight browsers in memory at once. The partition, concurrency, and worker counts remain configurable. Lighthouse and browser performance budgets run alone afterward in a dedicated single-worker container. All fresh blobs are required and merged into the same checklist; performance is isolated for measurement quality, not split into a separate release decision. Each sharded execution reserves a new run directory before any work starts and refuses an existing run ID without touching it, so stale lifecycle files, reports, media, or manual approvals cannot leak into a new decision. Coordinator deadlines, terminated shards, abnormal exits, and required media-stage failures force the generated checklist to `UNAVAILABLE`; its counts remain diagnostic while `sharded-run.json` remains the external release authority.

The portal is itself covered by a Docker browser/API acceptance suite. It checks asynchronous loading, the encrypted-key UI, the root-derived operator capability, DNS-rebinding Host rejection plus same-origin mutation protection, atomic launch capacity, browser-wide TLS-bypass rejection, a real targeted run with live logs, non-authoritative portal release labeling, serialized manual evidence, signature/probe/decode rejection of fake media, external sharded-run discovery from active through completed, descriptor-walk artifact containment and HTTP 206 video seeking, refresh/reconnect behavior, stopping portal-managed work, and guarded portal/external evidence purges that notify both live streams. Compact report data is written into immutable revision directories and exposed only after an atomic `current.json` switch; summary, filtered audit pages, and lazy-loaded details stay pinned to that exact digest-verified revision:

```sh
npm run portal:e2e
```

Portal visual baselines are generated only in the pinned Docker browser image. After inspecting the rendered Overview, indexes, workspace, launch/settings, report, gallery, and sealed-archive fixtures, an intentional visual change can be recorded with `npm run portal:e2e:update-snapshots`; a normal `npm run portal:e2e` must then pass without update mode.

Every run exposes a Visual Gallery as soon as finalized evidence exists. The workbench keeps the selected test dominant, groups and sorts by feature or technical suite, preserves a frozen review order until the reviewer accepts an update, and provides keyboard navigation, a virtualized overview, test context, reviewer flags, and bounded activity/execution/raw drawers. The generated Long Build Checklist contains the same shared gallery as an immutable read-only snapshot. It works over HTTP or by opening `checklist/gallery.html` directly; it never needs the full manifest or eager item/media downloads.

## Browser and device targets

Normal and sharded releases retain the same seven-project Chromium, Firefox, WebKit, mobile, tablet, desktop, production, and candidate matrix. Extra profiles are opt-in with `AUDIT_TARGET_IDS`; the registry includes recent/current iPhone WebKit emulations, Pixel and Galaxy Android Chromium emulations, Edge-compatible Chromium, and capability-gated branded Microsoft Edge. Invalid, duplicate, provider-only, or unavailable targets stop before launch.

Device emulation is labeled honestly: it covers viewport, input, scale, user-agent, and engine behavior inside the Linux container, not real iOS, Mobile Safari, Android Chrome, or physical hardware. The registry includes provider-ready metadata for real current/previous iOS and Android devices, but does not expose those rows as runnable until a real-device adapter and evidence pipeline exist. See [`docs/DOCKER.md`](docs/DOCKER.md#browser-and-device-target-matrix) for IDs, commands, Edge installation, and fidelity limits.

The canonical gallery scale gate is Docker-only:

```sh
npm run portal:e2e:scale
```

It rebuilds the pinned image, enforces exactly 2 CPUs and 4 GiB, physically creates and recounts the 5,659-artifact / 1,241-logical-item / 110-video / 17,527-stored-file corpus, then measures it. Before each invocation, only the exact portal-E2E output directory is cleared and a new running/passed/failed record is written, so stale green artifacts cannot survive a failed rerun. Results, all timing samples, resource profile, a network trace, portal/archive screenshots, and an interaction-navigation video are saved under `artifacts/portal-e2e/`. Host measurements are informational and cannot satisfy the release gate.

## Run without the portal

```sh
npm run audit:smoke
npm run audit:release
```

The smoke profile checks the environment and critical recovery paths. The release profile records every selected test and executes the full device/browser matrix. The checklist intentionally keeps unexecuted and physical-device checks visible as `NOT RUN` or `MANUAL`.

With the portal stack running, a second terminal can submit the same durable Single-site contract through the command adapter:

```sh
docker compose exec portal node scripts/run-single-site.mjs \
  --queue-root /var/lib/ai-mobile-testing/jobs \
  --url https://beta.quitting7oh-org.pages.dev \
  --role preview \
  --scope FULL
```

Use `--scope TARGETED` with one or more of `--targets`, `--plugins`, `--audits`, or `--areas`. Add `--ai-review <model-id>` only when advisory AI is desired. The command performs preflight, repeats validation at launch, and enqueues work; the worker and finalizer services must remain running. See [`docs/DOCKER.md`](docs/DOCKER.md#single-site-audit-operations) for recovery, TLS exceptions, baselines, and purge.

## AI evidence review

AI review is optional and advisory. The portal can save, replace, or delete a key from its Claude settings after the operator appends the root-derived unlock path printed in the portal service log to the published portal origin and opens it once. The resulting session is HttpOnly; workers receive neither capability nor cookie. The saved value is AES-256-GCM encrypted in a dedicated project-scoped Docker volume outside the repository and browser-discovery tree; only its status and short SHA-256 fingerprint are returned to the browser. The root supervisor can use credentials only when it has three separate non-root workers: Playwright and video processing run as `pwuser`, AI review runs as `aiworker`, and checklist generation runs as `reportworker` in private staging after the run tree is frozen. None can read the vault. The saved key reaches `aiworker` once through an anonymous stdin pipe, never through the worker environment. AI and report inputs use contained, descriptor-pinned/no-follow regular-file reads; the supervisor atomically publishes the completed staged checklist. The key is never stored in browser storage, source, run manifests, logs, reports, artifacts, image layers, or Compose configuration.

The default model is `claude-sonnet-5`; set `ANTHROPIC_MODEL` to an explicit supported model ID when needed. Portal AI review calls Anthropic's API and consumes separately billed API credits; Claude.ai Pro or Max subscription usage does not cover these calls. The pipeline logs the model, selected evidence names and sizes, HTTP status, latency, and token usage, but never authorization headers, request image data, or the API key. AI output cannot convert a failed deterministic check into a pass and is labeled for human verification.

## TLS and Netskope

TLS verification is strict by default. The Docker image includes this team's public Netskope root CA so normal production and beta checks validate certificates in the inspected network without disabling TLS. The public CA details live in [`certs/README.md`](certs/README.md); no private key is included.

Comparative runs never permit browser-wide certificate bypass. Playwright and Chromium implement it across a browser context or process, so it cannot remain limited to the candidate after redirects or subresource loads. Any `CANDIDATE_IGNORE_HTTPS_ERRORS=1` request fails before launch; install the development/Netskope CA instead.

Single-site Preview runs have a narrower, explicit development exception. `preview-bypass` is accepted only after confirming the Preview role and only when the exact normalized origin appears in comma-separated `AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST`. Production always remains strict. Bypass makes Evidence Authority non-authoritative even when the automated Site Health calculation would otherwise be `HEALTHY`; it is diagnostic development evidence, not trustworthy promotion evidence.

## What is tested

The shipped suite covers the complete candidate route inventory and these feature domains:

- availability, redirects, headers, cache policy, assets, error routes, sitemap, and indexing policy;
- production-to-candidate route mapping and intentional redesign parity;
- responsive shell, scheduling notice, header/footer, navigation drawer/sidebar, breadcrumbs, table of contents, and sharing;
- light/dark/system themes, breakpoint boundaries, narrow-screen overflow, and reduced motion;
- search dialog, keyboard navigation, relevance, filters, no-result guidance, and dependency failure;
- homepage starting paths, immediate-support panels, directory coverage, crisis actions, and third-party fallbacks;
- 7-OH taper and SR-17 calculators, arithmetic invariants, persistence, boundaries, copy, print, charts, and phone output;
- all sixteen SOWS items, score thresholds, copy logging, collapse/reopen, and reset;
- kratom, NA, and SMART meeting time states, timezone conversion, filter combinations, join/copy actions, history, and failure states;
- page structure, internal/external links, imagery, long and wide content, accessibility, performance, layout stability, and runtime failures;
- Chromium, WebKit, and Firefox emulations plus explicit physical-device and screen-reader acceptance rows.

The authoritative inventory contains 81 feature and cross-cutting contracts plus 102 generated route contracts. All 183 are first-class portal checks; the generated route family can be filtered, selected individually, or launched as part of the platform suite. The inventory is defined by [`audit/catalog.ts`](audit/catalog.ts) and the reviewed route inventory, then rendered as the reviewer-facing [`docs/ASSERTION_LEDGER.md`](docs/ASSERTION_LEDGER.md). Generated checklist rows link to their available video, poster, screenshot, trace, network/JSON, Lighthouse, and AI evidence. Test declarations must use `interactionTest(..., interactionEvidence("action → response"), ...)`, `staticTest(..., staticEvidence("relevant rendered state"), ...)`, or `structuredTest(..., structuredEvidence("machine-readable proof"), ...)`; validation rejects undecided tests and plugins. The assertion-quality gate also rejects tautologies, swallowed failures, conditional-only checks, observation-only cases, missing executable cases, and non-blocking P0/P1 definitions. Interaction actions live inside named `audit.step` checkpoints, and the fixture adds interaction-only pacing plus on-video test, step, pointer, and action labels so clips remain understandable during human review.

## Extend the suite

Feature tests are installed plugins written with Playwright and TypeScript. A plugin manifest provides stable audit definitions and allowlisted spec entries; the portal discovers those entries and never executes arbitrary commands supplied by a browser client. See [`docs/PLUGINS.md`](docs/PLUGINS.md) and the disabled starter under `plugins/_template/`.

Before shipping a plugin:

```sh
npm run plugins:validate
npm run typecheck
docker compose run --rm audit-smoke
```

## Documentation

- [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) — strategy, layers, evidence, and pass/fail rules
- [`docs/ASSERTION_LEDGER.md`](docs/ASSERTION_LEDGER.md) — generated promise-to-oracle, source, evidence, and target map for every audit
- [`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md) — launch sequence and human sign-off
- [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md) — requirement-to-implementation ledger
- [`docs/DOCKER.md`](docs/DOCKER.md) — container operations and troubleshooting
- [`docs/PLUGINS.md`](docs/PLUGINS.md) — adding a feature plugin
- [`docs/AI_REVIEW.md`](docs/AI_REVIEW.md) — AI scope, security, and review contract
