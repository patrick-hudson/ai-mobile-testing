# Release process

## One release architecture

A Single-site Audit examines exactly one Preview or Production deployment against standalone Product Oracles. A clean `FULL` run can grant `RELEASE READY` for that exact deployment; a clean `TARGETED` run can grant `FEATURE READY` only for its certified scope. Comparative mode uses the same durable runner, risk, recovery, report, and release-decision contracts while adding paired production/candidate oracles.

- **Automated decision** is authoritative for the executed scope. Product and visual assertion failures block that scope. Missing or unsafe evidence produces an incomplete, not-ready decision.
- **Coverage** reports what the compiled Single-site Product Oracle selected, omitted, classified as comparison-only, or could not execute. Coverage Gaps and known route limitations remain visible independently; they are not Findings and do not rewrite Site Health.
- **Manual acceptance** remains a visible Risk Register item but is non-blocking until a deterministic automated test fails.
- **Visual Review** reports same-site baseline outcomes such as `UNCHANGED`, `CHANGED`, `REVIEWED`, absent, incompatible, or unavailable. A baseline decision or human review disposition routes visual drift; it does not erase a deterministic Finding or alter Site Health or Coverage.
- **Pipeline Integrity** states whether collection, FFmpeg processing, immutable publication, and report generation completed safely. A pipeline failure makes the audit `INCOMPLETE`; a partial result must never be presented as healthy.

Evidence Authority qualifies every result. Strict TLS using the baked public Netskope CA is the default. An exact-origin Preview exception remains clearly flagged and non-blocking, so passing required work may still yield a scope-qualified ready decision. The bypass simultaneously makes the evidence non-authoritative: shared CI retains the digest-bound certificate policy, and exact promotion rejects non-strict evidence before provider preparation or claim consumption. Any other delivery policy must also reject or separately route it rather than equating readiness with promotion eligibility. Production-role runs remain strict.

The canonical shared release head—not a legacy checklist or shadow result—controls automation. See [Shared release authority](SHARED_RELEASE_AUTHORITY.md) for topology, recovery, CI, promotion, cutover, and rollback.

## Before the audit

- Confirm the production and candidate origins in the portal.
- Confirm the candidate deployment is the exact build intended for launch.
- Build the pinned Docker image from a clean dependency lock.
- Confirm startup reports the baked Netskope CA and that the run records strict TLS. Use the candidate bypass only for non-release investigation.
- Give every terminal-launched sharded release a new 8–80 character lowercase run ID. The coordinator refuses an existing evidence directory; archive or purge the prior run instead of reusing its name.
- Start with smoke, then run the release profile after smoke infrastructure issues are understood.
- Rotate or revoke any credential that was shared outside the intended secret store.

## Evidence run

1. Start the portal with Docker.
2. Launch Single-site or Comparative mode through the shared control plane. Legacy sharded and single-container results are historical/diagnostic and cannot authorize promotion after shared activation.
3. Keep the run detail open or reconnect later; logs and manifests are persisted.
4. Let the durable shared graph finish: ordinary browser work, exclusive performance work, Product Oracles, video processing/posters, immutable publication, report generation, and optional advisory AI review.
5. Do not delete failed-run artifacts. Failed videos and traces are the most useful debugging evidence.

Before final sign-off, open the run-wide Visual Gallery. Review the default attention queue first, then sort by feature suite and technical suite, filter failed/flaky/flagged work, inspect the selected test context, and use the overview for visual scanning. Accept a newly published order explicitly; do not assume live evidence silently reordered the frozen review. Open the generated checklist gallery as well and confirm its read-only snapshot revision/export time and final flag history match the retained release record.

For a release of the gallery or evidence pipeline itself, run `npm run portal:e2e:scale`. Keep the current invocation record, `gallery-scale-metrics.json`, the methodology/resource record, network trace, three screenshots, and interaction-navigation video with the release evidence. Confirm the invocation record says `passed` and the metrics report all 17,527 physically materialized and byte-verified files. Do not accept host timings, missing heap/media observations, a non-2-CPU/4-GiB profile, stale output from an earlier invocation, or any threshold failure.

## Triage

For each candidate P0/P1 finding, record:

- audit ID and affected route/project;
- exact failed expectation and observed value;
- whether production shows the same behavior;
- linked video, screenshot, trace, and response/runtime evidence;
- owner and disposition: fix, accepted risk, false-positive harness defect, or rerun required.

A harness defect must be fixed in this repository and rerun. A site defect must remain failed until a new candidate deployment proves the fix. Do not update a visual baseline until a human confirms that the difference is intended.

## Human review (non-blocking)

Use the manual checklist on real current and small-screen iPhone hardware, a representative Android device, and iPad portrait/landscape when human coverage is available. Run VoiceOver through navigation, search, calculators, score announcements, copy confirmation, and meeting status updates. Upload the video/screenshots in the portal and record reviewer/device/browser/notes. Outstanding rows stay at the front of the Risk Register but do not change the automated release decision.

## Go-live decision

Launch only when:

- candidate P0 failures are zero;
- candidate P1 failures are zero or have explicit owner-approved waivers;
- every critical journey has its required evidence;
- deterministic visual assertions have no unresolved failures; human-only visual risks remain visibly assigned;
- TLS was verified without a development bypass;
- manual device and screen-reader risks are visible and assigned; they do not block automation by themselves;
- preview indexing/canonical behavior matches the deployment stage;
- the final portal checklist and run logs are retained with the release record.
- the Visual Gallery scale/accessibility gate is green in the canonical Docker profile and its metrics/trace/captures are retained.
