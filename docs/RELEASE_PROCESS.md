# Release process

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
