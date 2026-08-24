# Requirements traceability

This ledger prevents requirements from disappearing as the suite evolves.

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Compare old and redesigned environments | paired environment/project metadata and production route mapping | paired smoke/release projects and checklist environment badges |
| Test every published feature and route | explicit 102-route inventory, stable 81-item audit catalog, feature specs | inventory contract plus page/full-sweep checklist rows |
| Find visual redesign defects | matched viewport captures, strict visual snapshots, all-route top/middle/bottom evidence, distributed long-page baselines, overflow/layout checks | videos, screenshots, diffs, page geometry |
| Videos with full context | release-profile video plus structured audit attachment and reporter evidence gate | checklist row links, video manifest, poster, checksum |
| Non-technical per-run report | compact report data, paged audit API, lazy evidence/detail/log loading | portal reviewer report, release summary, filters, manual and AI sections |
| Large-run browser safety | capped compact JSON layers, incremental artifact index, abortable requests, bounded DOM pages and 64 KiB log preview | portal acceptance suite verifies the raw manifest/log are not fetched eagerly |
| Run-wide visual review | one revisioned logical-media catalog, shared portal/archive workbench, queue/overview modes, suite grouping, filters, context, flags, and keyboard/focus contract | Docker gallery journeys, immutable checklist gallery, direct-file acceptance, saved portal/archive captures |
| Exact reference scale | 5,659 artifacts, 1,241 logical items, 110 validated videos, 17,527 physically written/recounted corpus files; 256 KiB chunks, 512 KiB details, 100-row pages | `gallery-scale:self-test` and canonical `portal:e2e:scale` raw metrics/materialization counts |
| Gallery responsiveness | first-usable mark before deferred thumbnails; independent abort generations; virtualized queue/overview; one selected video; byte-aware retained revision cache | 5+30 cold and 10+100 warm Docker samples, p95 thresholds, ≤500 DOM, ≤25 MiB heap, 50-change stale-work proof |
| Portable archived review | embedded pinned descriptor plus source/token/revision-validated one-shot iframe wrappers; published-order fast path; contained evidence URLs | normal no-flag `file://` and HTTP browser acceptance, ≤3 cold wrappers, zero leaked iframes, read-only capture |
| Reclaim obsolete run storage | terminal-state-only purge API and typed-confirmation UI with artifact-root, direct-child, real-path, symlink, and active-run guards | Docker portal acceptance purges isolated portal/external fixtures, verifies byte/file counts, and rejects active, mistyped, and symlink targets |
| Long build checklist | catalog includes automated and manual requirements even when unexecuted | searchable offline checklist with NOT RUN/MANUAL states |
| Portal launches targeted tests | allowlisted profile/project/plugin/area/audit selection | portal API validation and end-to-end Docker portal run |
| Launch capacity survives initialization faults | append streams must emit `open` before registration/spawn; the pre-await reservation stays held through persisted registration; stream/persistence/spawn setup errors become terminal retained records or are removed if storage is unavailable | isolated injected stream-open, persistence, and spawn failures are purgeable and do not block the next launch |
| Portal evidence cannot impersonate canonical signoff | explicit single-container review-only provenance; any review reason downgrades a `READY` checklist to `review-required`; report hero shows signoff withheld | pure READY/TLS/flaky/reduced/canonical self-test plus synthetic READY reviewer-report journey |
| Local portal trust boundary | request-wide loopback/allowed Host validation plus same-origin mutations; DNS rebinding rejected before reads or writes | hostile matching Host/Origin and missing-Origin API regressions across credential/run/stop/purge/manual routes |
| Manual evidence integrity | per-run upload/attestation/rebuild mutex plus signature, FFprobe stream, and FFmpeg first-frame validation with cleanup | concurrent upload/attestation API checks and fake-PNG rejection/no-file regression |
| Durable artifact delivery | contained real path plus opened no-follow descriptor, handled stream lifecycle, and byte ranges | outside-run symlink, disappeared file, playable HTTP 206 video checks |
| Bounded restart recovery | portal restart replays at most a 1 MiB runner-log tail | security self-test materializes a multi-megabyte log and verifies the bounded tail includes recent progress |
| Purge closes every observer | one purge event closes/clears run and gallery SSE clients and heartbeat timers | Docker acceptance observes purge on both streams before evidence disappears |
| Track run start through finish | persisted manifest, phases, timestamps, SSE replay/reconnect, stop state | refresh/reconnect portal acceptance test |
| Slow portal work stays understandable | asynchronous requests, busy regions, skeletons/spinners, disabled duplicate actions, reduced-motion support | delayed-response and interaction acceptance checks |
| Verbose useful logs | commands, stages, test progress, steps, HTTP responses, errors, timings, exits | persisted `logs/runner.log` and visible portal stream |
| Docker portability and Mac stability | pinned official Playwright Linux image and Compose services | image build, container smoke, portal-run evidence |
| Fast runs without invalid performance regressions | parallel functional shards followed by a dedicated one-worker Lighthouse container; every fresh blob merges into one decision; the coordinator atomically reserves a new run directory and refuses prior evidence | exact 1,337 + 70 discovery partition, stale/missing blob and existing-run refusal self-tests, portal stage visibility |
| External lifecycle truth cannot contradict itself | portal derives terminal state from `pipeline.status === completed`, `pipeline.completed === true`, fully normalized checklist release fields (`ready`, reason, blocker counts, integrity), and the matching declared lifecycle status; contradictions become `evidence-failed` with reported fields retained as diagnostics | external discovery rejects both `ready`/running/`NOT_READY` and completed/`READY`-with-blockers fixtures, then recovers only after a fully consistent rewrite |
| Netskope and development TLS | baked public CA, strict default, explicit recorded candidate-only exception | strict container requests plus non-ready bypass run |
| FFmpeg visibility and video processing | post-run poster/checksum manifest with command logging | `video-manifest.json`, poster files, stage log |
| AI evidence review | optional Anthropic post-run analyzer with secret-safe runtime injection | AI JSON/HTML output, API status/latency/usage logs, no-key dry run |
| Save Claude key in portal | encrypted Docker credential vault with replace/delete and fingerprint-only state | save/restart/delete acceptance using a synthetic key plus plaintext leakage scan |
| AI cannot hide deterministic failures | advisory label and reporter release policy | checklist retains original test disposition |
| Extensible tests | validated installed Playwright/TypeScript plugin manifests | validation command, first-party plugins, disabled starter |
| Ship plugins for redesigned site | platform/content, UX, calculators, meetings, accessibility/performance/reliability plugins | portal discovery and plugin selection |
| CI | Docker smoke/release workflows and retained artifacts | workflow configuration plus container commands |
| Physical-device honesty | manual real-device and screen-reader audit rows | checklist remains incomplete until human evidence is attached |
