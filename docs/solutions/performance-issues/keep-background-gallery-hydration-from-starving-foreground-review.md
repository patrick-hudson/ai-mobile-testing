---
title: Keep background gallery hydration from starving foreground review
date: 2026-08-28
category: performance-issues
module: ai-mobile-testing
problem_type: performance_issue
component: frontend
symptoms:
  - rapid keyboard traversal made the selected evidence detail and media slow to settle
  - background thumbnail work survived selection changes and could complete for obsolete filmstrip windows
  - selected-detail and thumbnail consumers could duplicate the same item-detail request
root_cause: concurrency
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
  - observability
tags:
  - evidence-gallery
  - request-scheduling
  - keyboard-navigation
  - cancellation
  - request-coalescing
  - playwright
  - docker
---

# Keep background gallery hydration from starving foreground review

## Problem

The Visual Evidence Gallery has two classes of work with different urgency. Foreground work makes the reviewer's current selection usable; background work makes nearby filmstrip thumbnails convenient. Treating them as peers let thumbnail hydration from intermediate selections compete with the final selected detail and media during rapid keyboard traversal.

The durable boundary is more than a thumbnail cache. The gallery needs explicit foreground ownership, cancellable background scheduling, stale-result suppression, and sharing when a thumbnail warm-up and the selected viewer converge on the same revision-bound detail request.

## Symptoms

- Rapid keyboard traversal spent request and decoding capacity on thumbnails from filmstrip windows the reviewer had already left.
- A thumbnail lookup and the selected-detail lookup could request the same item concurrently.
- Cancelling only one caller could leave obsolete underlying work running or abort work another consumer still needed.
- Late completions needed to be prevented from changing the viewer after a newer selection or content revision became authoritative.
- A visual spot-check could not establish that the fix preserved the canonical latency, DOM, media, memory, and stale-commit gates (`scripts/run-portal-e2e.mjs:34-49`, `portal/tests/gallery.spec.ts:1999-2011`).

## What Didn't Work

Eagerly resolving thumbnails as soon as the filmstrip rendered was the wrong priority model. Filmstrip rendering can happen before the selected media is usable and can repeat while navigation crosses window boundaries. The corrected controller enables thumbnail resolution only after the first usable selected item, then schedules another bounded filmstrip and overview render (`portal/public/gallery-core.js:1996-2014`). The deterministic regression test requires zero thumbnail calls during initial selected-media work and while rapid traversal crosses several windows (`scripts/gallery-state-self-test.mjs:701-739`).

Cancelling obsolete UI consumers alone was also incomplete. Thumbnail resolution obtains the same item detail used by the selected viewer (`portal/public/gallery.js:283-309`, `portal/public/gallery.js:325-331`). Independent fetches duplicate exact work, while tying shared transport to one consumer's abort signal can break another consumer. The request-sharing layer therefore needs independent consumer lifetimes.

Weakening the performance gates would only hide contention. The benchmark continues to require cold p95 at or below 2,000 ms, warm browser-ready p95 at or below 200 ms, no more than 500 gallery DOM nodes, exactly one video, heap growth below 25 MiB, and zero stale commits (`portal/tests/gallery.spec.ts:2000-2011`). The benchmark-only ten-minute terminal refresh interval defers recurring immutable-terminal refresh scans during the canonical navigation measurements while leaving the production 30-second default unchanged (`scripts/run-portal-e2e.mjs:62-68`, `portal/server.mjs:242`, `portal/server.mjs:5402-5420`).

## Solution

Give foreground selection an explicit veto over thumbnail hydration. The default thumbnail scheduler waits for a 150 ms quiet period and then uses `requestIdleCallback` when available. Its cancellation function clears both the timer and a pending idle callback (`portal/public/gallery-core.js:876-893`). The workbench separately tracks its thumbnail queue, pump generation, active work, cancellable schedule, and whether foreground media is pending (`portal/public/gallery-core.js:904-928`).

On a selection change, pause thumbnail work before starting detail or media work. Pausing advances the pump generation, cancels the scheduled callback, clears queued rows, and aborts an active thumbnail request unless that request is warming the newly selected item (`portal/public/gallery-core.js:1172-1183`, `portal/public/gallery-core.js:1261-1273`). Selected detail and media use independent abortable request slots whose generations advance before dispatch (`portal/public/gallery-core.js:1003-1029`, `portal/public/gallery-core.js:1083-1127`).

Resume background hydration only after the selected media element loads or fails, or after foreground detail or media resolution fails (`portal/public/gallery-core.js:1161-1165`). At that point, discard any queue assembled by intermediate renders and rebuild only the final local filmstrip window. The queue warms the next item first, alternates through neighboring items, and leaves the already visible selection until last (`portal/public/gallery-core.js:1185-1214`). The pump refuses to start or continue after foreground work resumes or its captured generation becomes obsolete (`portal/public/gallery-core.js:1217-1240`). Destruction applies the same invariant by invalidating the pump, cancelling its schedule, clearing its queue, and aborting each request slot (`portal/public/gallery-core.js:2037-2048`).

Coalesce exact revision-bound detail requests below the controller. `loadItem` checks the bounded detail cache, joins an in-flight entry with the same accepted revisions and item ID, or creates one shared underlying request (`portal/public/gallery.js:283-309`, `portal/public/gallery.js:468-476`). Each consumer independently subscribes to that promise. Aborting one consumer releases only that consumer; the underlying request is aborted only when its last consumer leaves (`portal/public/gallery.js:479-506`). A thumbnail request already warming the new selection can therefore be retained while the foreground selected-detail consumer joins it (`portal/public/gallery-core.js:1261-1265`).

Keep reducer validation as a second line of defense. An asynchronous request completion mutates state only when its generation and semantic key match, and revision-bound request work must match the accepted content revision. Selected detail, availability, media, and flag work must still target the active item, while selected-media work must target the active member (`portal/public/gallery-core.js:334-344`). Thumbnail results also pass through the trusted-media decoder before entering retained state (`portal/public/gallery-core.js:614-621`). Cancellation improves responsiveness, while generation and identity checks keep late transport completion from corrupting the current review.

## Why This Works

The quiet period converts a burst of navigation into one final background decision. Every foreground selection invalidates the prior pump and empties its queue, so intermediate windows do not accumulate work. Waiting for selected media to settle keeps background detail and image work behind the artifact the reviewer is actively inspecting. Rebuilding the queue after settling prevents DOM-order work recorded during the burst from surviving; next-first ordering improves the likely next transition without expanding the bounded window.

Revision-aware coalescing solves a separate handoff race. Thumbnail and selected-detail consumers may legitimately converge on one item as background warming becomes foreground review. Sharing that exact request prevents duplicate network work, while independently counted consumers ensure an obsolete caller cannot cancel data still required by the current one. The browser scale test makes both properties observable by bounding detail-request count and requiring captured detail URLs to be unique during foreground traversal (`portal/tests/gallery.spec.ts:1807-1814`).

Generation checks make late resolution harmless even if transport cancellation is not instantaneous. The scale test records viewer mutations during 50 rapid query changes and counts any title committed after the final expected selection as stale (`portal/tests/gallery.spec.ts:1845-1872`); the hard gate requires zero stale commits (`portal/tests/gallery.spec.ts:2007-2011`). The canonical test runs only under the pinned 2 CPU and 4 GiB Docker profile, making results comparable across hosts (`portal/tests/gallery.spec.ts:1578-1589`, `docker-compose.yml:130-149`).

The change passed the deterministic gallery state test, the full portal browser suite, and the canonical fixed-resource scale gate in the session that produced this learning.

## Prevention

- Preserve the foreground/background split. Any new preview, poster, AI annotation, or metadata prefetch must use the cancellable quiet/idle path and must not begin before selected evidence is usable.
- Keep cache and in-flight request keys tied to every accepted revision that changes detail meaning; do not coalesce only by item ID.
- Treat abort signals as consumer ownership, not automatically as ownership of shared transport. Abort shared work only when no consumers remain.
- Keep both defenses: proactively abort and invalidate obsolete work, then reject late reducer actions by generation, semantic key, revision, item, and member identity.
- Test the scheduler deterministically. The state self-test injects a controllable thumbnail scheduler, traverses multiple windows before releasing tasks, and requires only the final window in next-first priority order (`scripts/gallery-state-self-test.mjs:701-756`).
- Retain request-level assertions in the real-browser scale test. Warm traversal must not add thumbnail-driven detail requests, exact request URLs must not duplicate, and rapid supersession must produce zero stale commits (`portal/tests/gallery.spec.ts:1807-1814`, `portal/tests/gallery.spec.ts:1864-1872`).
- Do not trade correctness for a greener benchmark. Keep the canonical resource profile and established latency, DOM, media, memory, and stale-work thresholds; isolate unrelated benchmark noise at its source (`scripts/run-portal-e2e.mjs:34-49`, `scripts/run-portal-e2e.mjs:62-68`).

## Related Issues

- [Run Visual Evidence Gallery plan](../../plans/2026-08-24-0636-feat-run-visual-evidence-gallery-plan.md) defines the bounded-window, cancellation, and scale contracts this solution implements.
- [Requirements traceability](../../REQUIREMENTS_TRACEABILITY.md) maps gallery responsiveness requirements to their executable evidence.
- [Test plan](../../TEST_PLAN.md) is the normative benchmark methodology and threshold reference.
- [Docker guide](../../DOCKER.md) describes the reproducible fixed-resource scale command.
- [Trustworthy comparative visual release audits](../best-practices/trustworthy-comparative-visual-release-audits.md) covers evidence and verdict correctness; this learning covers responsive review of that evidence.
