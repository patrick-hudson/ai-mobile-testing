# Single-site Audit completion evidence

This matrix closes the Product Contract in
[`2026-08-25-0240-feat-single-site-audit-mode-plan.md`](plans/2026-08-25-0240-feat-single-site-audit-mode-plan.md).
A product `FINDINGS` verdict is successful pipeline evidence when Coverage, required evidence, and Pipeline Integrity are complete. It is not rewritten as a green product result.

## Verification ledger

| Evidence | Result |
| --- | --- |
| Complete source contract | `npm run validate` passed during the Docker build of final OCI image `sha256:da7a09bde96e6783dc7542d6809e16f501e6ec68470c6cfccb012895f0e71028`, whose embedded runner source is `image:sha256:a1d453c92829d61d3a94d0ca629ff1689bb4cf139b59100cd297ac9ae0fe1a6f`. |
| Docker identity boundary | `npm run docker:identity:self-test` passed against the final image and proved root submission, non-root `pwuser` claim/update, and root verification through a real named queue volume. The live topology is one healthy portal, two workers configured for four Playwright workers per job, and one finalizer, all on the final OCI image. |
| Portal browser suite | Final isolated Docker run passed 27/27. The deterministic duplicate-revision regression passed; the canonical 5,659-artifact/1,241-media gallery measured cold p95 286.2 ms, warm p95 179 ms, 380 peak DOM nodes, 412,752 bytes heap growth, and zero stale commits. |
| Beta smoke | `job-f33503138573-d1ff70b9646c`: finalization `7aa7d5d2d68fbd959899f2177acd8a458303e053ab4e552a9d2a2cd1e064e766`, receipt `c509f5d49e97328316b00d66908863bfb2ca525425d9afde3412a8d3ee1846a2`, Coverage `COMPLETE`, authoritative evidence, media complete, and a visually inspected eligible desktop `CONTENT-001` capture. Product result `FINDINGS` retains the detected site issue. |
| Beta targeted | `job-96e175c9ec6a-d2f912b5662c`: 22 definitions and 37 planned executions; finalization `78dbdd3da94c2ae2ed3732d6ac36ded07c4f225186c4f66f7622070411560e1f`; receipt `c3283fe8c839951958f3d2c83f2a6e34dcad8fd21c7460bd36b529b9dd3f0c85`; Coverage `COMPLETE`; authoritative `FINDINGS`; 46/46 retained interaction videos usable; zero rejected executions or media-integrity errors. SEARCH-002 passed on desktop and mobile with observable post-content changes and no blank mobile frames. |
| Beta full | `job-205caefcaa4f-7fecbbf35332`: 181 definitions, 192 cases, and 385 planned executions; finalization `f42b41fd384e7559e32a369f8a88d11a1c91bb5435b1666f5e1a2f27d98f480f`; receipt `1678301075c17e2f7c0696e4dee1ff8fceda0d2e392c11a131a69556a879ce2f`; compiled scope Coverage `COMPLETE`; authoritative evidence; 934 gallery items (829 images and 105 videos); media complete with 102 usable interaction videos and zero failed, unavailable, or integrity-error media. The report truthfully remains `INCOMPLETE` with Product Oracle Coverage `GAPS`: 231 findings, two timed-out and two flaky executions, five manual checks, and five inventory-source limitations. |
| Beta baseline follow-up | Source `job-f33503138573-d1ff70b9646c`, follow-up `job-3053991290f9-b7857a8cadc8`, active baseline `vb-ea620310d69be4cf6af46c10`, store revision 2, history `sha256:04337463e18cb024f80c9aa9bcefb169e156f62a74f5323420533d248003c4ad`, and compatible `UNCHANGED` result (`0.0011721` <= `0.0025`). Digest-bound workflow proof: `artifacts/baseline-follow-up/job-f33503138573-d1ff70b9646c-job-3053991290f9-b7857a8cadc8.json`, digest `sha256:778678d0fd1b63b61b08fcea021baa436495003e769e467326d9bac4c26ca9a7`. The explicit Finding waiver preserves the separate unresolved `CONTENT-001` finding. |
| Four-run closeout manifest | `artifacts/single-site-completion/final-single-site-beta-closeout.json`, digest `acd6fecbb60985afd9bd32ee82016c049821c03eee80df154416559a3a876e2e`, re-verifies all receipts and their report, gallery, media, visual, scope, runner, preflight, route-inventory, and finalization bindings. |
| Comparative regression | `npm run audit:smoke` completed the 91-test, seven-target matrix with 37 passes, 30 applicability skips, and 24 genuine product failures; the checklist truthfully remained `NOT_READY` with `runIntegrityFailure: false` instead of converting findings into a harness pass. `release-truth:self-test`, `targets:self-test`, and the two digest-bound evidence-generator self-tests passed. Comparative promotion authority remains isolated from Single-site advisory results. |

## Product requirements

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| R1 | Verified | Mode-discriminated portal and command launch; `run-context:self-test`, `single-site-command:self-test`, and portal launch journey. |
| R2 | Verified | The Single-site contract accepts one normalized URL; preflight/compiler/command tests reject a second-origin dependency. Live beta jobs contain one audited URL. |
| R3 | Verified | Portal role suggestion and explicit confirmation are covered by the launch journey and `single-site-launch:self-test`. |
| R4 | Verified | Confirmed role is digest-bound through preflight, compiler, queue checkpoint, baseline identity, and report; covered by preflight/launch/baseline tests. |
| R5 | Verified | Side-effect-free rejection, focus recovery, preserved selections, stale-preview revalidation, and zero-job failure paths pass the portal launch journey and preflight/launch tests. |
| R6 | Verified | `run-compiler:self-test` maps selected definitions to standalone cases/executions, retains Coverage Gaps, and excludes comparison-only cases before execution. |
| R7 | Verified | Compiler/enumeration prove 181 selected definitions, 192 executable cases, and 385 planned executions across the complete profile; the beta full job uses that manifest. |
| R8 | Verified | Smoke and targeted reports retain `TARGETED`, selected and omitted coverage; the full manifest retains `FULL`. Portal/command requests use the same canonical compiler. |
| R9 | Verified | `targets:self-test` proves neutral `single-site-*` browser/device IDs independent of deployment role. |
| R10 | Verified | `route-inventory:self-test` and `live-route-inventory:self-test` prove deterministic catalog, manifest/sitemap, navigation, and bounded same-origin discovery union. |
| R11 | Verified | Route-inventory mutation fixtures prove missing/unreachable reviewed routes become Findings while policy exclusions remain inventory evidence. |
| R12 | Verified | Live-route/compiler fixtures prove generic inspection for unreviewed routes and separate Product Oracle Coverage Gaps. |
| R13 | Verified | Generated `PAGE-*` contracts plus response, identity, structure, metadata, asset, runtime, overflow, link, accessibility, and evidence assertions are registry- and mutation-tested. |
| R14 | Verified | Docker queue/worker/finalizer pool tests and all live beta runs show asynchronous execution, commands, HTTP responses, heartbeats, Playwright output, FFmpeg stages, and finalization. |
| R15 | Verified | `evidence-policy:self-test`, `video-retention:self-test`, and media finalization tests enforce interaction videos, static screenshots, and structured-only evidence. |
| R16 | Verified | Portal E2E plus report, gallery, artifact, AI, purge, and retention self-tests cover finalized Single-site context and bounded access. |
| R17 | Verified | AI mode-aware, supervisor, and portal API tests prove advisory-only output cannot mutate Findings, Site Health, baselines, reviews, credentials, stop, or purge. |
| R18 | Verified | `site-health:self-test` and report-input mutations prove `INCOMPLETE` before `FINDINGS` before `HEALTHY`, with Evidence Authority independent. |
| R19 | Verified | Release-truth and Single-site report tests reject cross-mode parsing and preserve comparative promotion authority unchanged. |
| R20 | Verified | Site Health/report tests and portal report journey keep manual status co-visible without changing automated health. |
| R21 | Verified | Live smoke shows comparison-only definitions in `outsideMode`, not audit rows, skips, failures, or Coverage Gaps. |
| R22 | Verified | Live beta executions run deterministic assertions without a baseline; baseline/visual comparison tests prove comparison is post-test and non-authoritative. |
| R23 | Verified | Smoke and targeted runs finalized completely with screenshots and absent comparisons; no baseline was required for Site Health. |
| R24 | Verified | Baseline contract/store/API tests prove completed-run approval with actor/time and exact role, route, target, viewport, theme, audit, capture, and rendering identity. Live approval proof is recorded in the ledger. |
| R25 | Verified | Visual-comparison and gallery journeys bind baseline/current/diff/status without changing deterministic Findings. Live compatible follow-up is recorded in the ledger. |
| R26 | Verified | Baseline history tests cover active, replaced, revoked, deleted, incompatible, and absent states with tombstoned provenance and retained digests. |
| R27 | Verified | The baseline store uses an independent named volume and never writes repository screenshot expectations; store and Docker tests prove separation. |
| R28 | Verified | Portal E2E covers semantic names, focus, keyboard traversal, touch targets, live announcements, narrow/wide layouts, media descriptions, and reduced motion. |
| R29 | Verified | Compact-report tests and live report APIs expose URL, role, qualifier, selected/omitted coverage, Coverage, evidence, authority, Findings, and manual status; targeted/non-authoritative health is qualified. |
| R30 | Verified | Compiler, Site Health, and report-input tests keep `COMPLETE`/`GAPS`/`UNKNOWN` independent from Findings and treat operator omissions as omissions, not gaps. |
| R31 | Verified | Route inventory records every source contribution/disposition and explicit enumeration limitations; route inventory tests mutate each boundary. |
| R32 | Verified | Comparison/review stores and gallery journey cover `UNCHANGED`, `CHANGED`, and append-only `REVIEWED` with attention ordering and no health/release mutation. |
| R33 | Verified | Baseline API/gallery journeys prove exact preview, confirmation, actor/time/source/rationale/history, media eligibility, Finding waiver, CAS, and stale-revision recovery. |
| R34 | Verified | Queue/pool and portal reconnect journeys independently exercise durable execution, worker activity, and client connection state with retained logs, cursors, loading/retry states, and lease-driven recovery. |
| R35 | Verified | Plugin metadata and compiler tests require all three Single-site classifications, exclude comparison-only definitions, and turn missing standalone-required cases into Coverage Gaps. |
| R36 | Verified | Preflight tests require fetched application identity markers, public DNS pinning, and redirect/rebinding bounds; hostname alone fails. Deployment revision is retained when available but is not an identity prerequisite. |

## Implementation units

| Unit | Status | Evidence |
| --- | --- | --- |
| U1 | Verified | Run/target/TLS contracts, registries, generated definitions, and strict validation pass. |
| U2 | Verified | Side-effect-free preflight, route inventory, compiler, stale-preview rejection, and immutable manifest bindings pass and are exercised live. |
| U3 | Verified | 178 automated oracle contracts and 183 ledger rows pass mutation canaries; comparison-only cases are absent from Single-site execution. |
| U4 | Verified with accepted limits | Durable named-volume queue, fencing, leases, recovery, cross-identity writes, two live workers, and deterministic finalizer pass. One job is owned by one worker and exactly one finalizer is supported; see accepted limitations. |
| U5 | Verified | Site Health, Coverage, Evidence Authority, manual status, visual review, pipeline integrity, compact pages, and comparative isolation pass. |
| U6 | Verified | Transactional baseline lifecycle, copied media, post-test comparison, immutable revisions, purge independence, waivers, and human review dispositions pass; live follow-up is recorded above. |
| U7 | Verified | Launch, lifecycle, report, gallery, baseline, purge, async loading/retry, accessibility, security, and reference-scale portal journeys pass in Docker. |
| U8 | Verified | Mode-aware advisory AI, documentation, assertion-quality gates, named beta proofs, and comparative regressions are covered by the ledger. |

## Accepted operational limitations

- Run exactly one portal and one Single-site finalizer. Active/active coordination for those services is not implemented.
- Worker replicas increase throughput across independent jobs. A single full Single-site job is not distributed across worker containers; its Playwright worker count provides bounded intra-job concurrency.
- Run and baseline cleanup is explicit and operator-driven. Automatic age-based retention and garbage collection are not implemented.
- iOS/Android targets are reviewed browser emulations. Physical devices, Mobile Safari, Android Chrome, and assistive-technology acceptance remain explicit manual work.
- Branded Edge is build-time capability-gated; the default Chromium Edge-compatible profile is available without downloading Edge.
