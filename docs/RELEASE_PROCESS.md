# Release process

## Single-site Audit interpretation (advisory and non-gating)

A Single-site Audit examines exactly one Preview or Production deployment against standalone Product Oracles. It does not compare two origins, make a release decision, or substitute for the comparative release process below. Read its final report as several independent truths rather than one green or red gate:

- **Site Health** is advisory for the executed automated scope. `HEALTHY` means the required executions completed without deterministic Findings; `FINDINGS` means they completed with one or more Findings; `INCOMPLETE` means required execution, evidence, processing, or publication did not complete safely. Always retain the `FULL` or `TARGETED` scope qualifier—a targeted `HEALTHY` result is not whole-site approval.
- **Coverage** reports what the compiled Single-site Product Oracle selected, omitted, classified as comparison-only, or could not execute. Coverage Gaps and known route limitations remain visible independently; they are not Findings and do not rewrite Site Health.
- **Manual acceptance** remains a separate human record. Browser automation, AI interpretation, and a healthy automated result cannot complete physical-device, assistive-technology, or visual-design review.
- **Visual Review** reports same-site baseline outcomes such as `UNCHANGED`, `CHANGED`, `REVIEWED`, absent, incompatible, or unavailable. A baseline decision or human review disposition routes visual drift; it does not erase a deterministic Finding or alter Site Health or Coverage.
- **Pipeline Integrity** states whether collection, FFmpeg processing, immutable publication, and report generation completed safely. A pipeline failure makes the audit `INCOMPLETE`; a partial result must never be presented as healthy.

Evidence Authority qualifies every result. Strict TLS using the baked public Netskope CA is the default. The `preview-bypass` exception is allowed only for an explicitly confirmed and exact-origin-allowlisted Preview deployment, and it makes the resulting evidence non-authoritative. Production-role Single-site runs remain strict. A non-authoritative result, including an otherwise `HEALTHY` one, is diagnostic evidence and must be described with that qualification.

Use a Single-site result to investigate Findings, assign follow-up work, complete manual review, approve or disposition eligible visual evidence, and rerun the same deployment. It neither authorizes nor blocks deployment or promotion. The go-live rules below belong only to the established comparative production-versus-candidate process; a Single-site result cannot satisfy or veto that checklist.

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
2. Use a portal release launch for interactive review and debugging, or launch the authoritative release with a new ID via `npm run audit:release:sharded`. Never treat a portal single-container `READY` checklist as final signoff.
3. Keep the run detail open or reconnect later; logs and manifests are persisted.
4. Let the full pipeline finish: parallel functional Playwright shards, the isolated single-worker Lighthouse/performance container, blob freshness preflight, video processing/posters, report generation, and optional AI review.
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

## Human acceptance

Complete the manual checklist on real current and small-screen iPhone hardware, a representative Android device, and iPad portrait/landscape. Run VoiceOver through navigation, search, calculators, score announcements, copy confirmation, and meeting status updates. Upload the video/screenshots in the portal, record reviewer/device/browser/notes, and explicitly attest the result. A manual pass cannot be saved without its required media, and the portal will reject a file whose declared type, byte signature, visual stream, or first decoded frame is invalid.

## Go-live decision

Launch only when:

- candidate P0 failures are zero;
- candidate P1 failures are zero or have explicit owner-approved waivers;
- every critical journey has its required evidence;
- visual differences are understood and approved;
- TLS was verified without a development bypass;
- manual device and screen-reader rows are signed off;
- preview indexing/canonical behavior matches the deployment stage;
- the final portal checklist and run logs are retained with the release record.
- the Visual Gallery scale/accessibility gate is green in the canonical Docker profile and its metrics/trace/captures are retained.
